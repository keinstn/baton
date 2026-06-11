import type { AgentEvent } from "../agent/runner.js";
import type { BatonConfig, ValidationResult } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { Issue } from "../tracker/types.js";
import { norm } from "../util.js";

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  startedAtMs: number;
  sessionId: string | null;
  lastEvent: string | null;
  lastEventAtMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  retryAttempt: number | null;
}

export interface AgentTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export type RunWorker = (
  issue: Issue,
  attempt: number | null,
  onEvent: (event: AgentEvent) => void,
) => Promise<void>;

export interface OrchestratorDeps {
  tracker: { fetchCandidateIssues(): Promise<Issue[]> };
  runWorker: RunWorker;
  validate: () => ValidationResult;
  /** Getter so Phase 2 hot reload can swap config between ticks. */
  config: () => BatonConfig;
  logger: Logger;
  now?: () => number;
}

/** Dispatch sort order (SPEC §8.2): priority asc (null last) → created_at oldest → identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ca = a.createdAt ?? "9999-12-31T00:00:00Z";
    const cb = b.createdAt ?? "9999-12-31T00:00:00Z";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.identifier < b.identifier
      ? -1
      : a.identifier > b.identifier
        ? 1
        : 0;
  });
}

/** Candidate eligibility (SPEC §8.2), excluding concurrency-slot checks. */
export function isDispatchEligible(
  issue: Issue,
  config: BatonConfig,
  state: { running: ReadonlySet<string>; claimed: ReadonlySet<string> },
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state)
    return false;
  if (issue.closed) return false;

  const tracker = config.tracker;
  const s = norm(issue.state);
  if (!tracker.activeStates.some((a) => norm(a) === s)) return false;
  if (tracker.terminalStates.some((t) => norm(t) === s)) return false;
  if (tracker.repos && !tracker.repos.includes(issue.repository)) return false;

  for (const label of tracker.requiredLabels) {
    const wanted = norm(label);
    // A blank configured label matches no issue (SPEC §5.3.1).
    if (wanted === "") return false;
    if (!issue.labels.includes(wanted)) return false;
  }

  if (state.running.has(issue.id) || state.claimed.has(issue.id)) return false;

  // Blocker rule applies to the first active state ("Todo" by default).
  const firstActive = norm(tracker.activeStates[0] ?? "todo");
  if (s === firstActive && issue.blockedBy.some((b) => !b.terminal))
    return false;

  return true;
}

/**
 * Poll-tick orchestrator (SPEC §7-8). Single authority for dispatch state.
 *
 * Phase 1 scope: tick → validate → fetch candidates → sort → dispatch with
 * global/per-state concurrency; worker exit releases the claim. Retry timers
 * and reconciliation are Phase 2.
 */
export class Orchestrator {
  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly completed = new Set<string>();
  readonly totals: AgentTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };

  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const log = this.deps.logger;
    const validation = this.deps.validate();
    if (!validation.ok) {
      for (const err of validation.errors) {
        log.error("dispatch preflight validation failed", {
          code: err.code,
          detail: err.message,
        });
      }
      return; // SPEC §6.3: skip dispatch for this tick.
    }

    let issues: Issue[];
    try {
      issues = await this.deps.tracker.fetchCandidateIssues();
    } catch (err) {
      // SPEC §11.4: candidate fetch failure → log and skip dispatch this tick.
      log.error("candidate fetch failed", { error: String(err) });
      return;
    }

    const config = this.deps.config();
    for (const issue of sortForDispatch(issues)) {
      if (this.availableSlots(config) <= 0) break;
      if (
        !isDispatchEligible(issue, config, {
          running: new Set(this.running.keys()),
          claimed: this.claimed,
        })
      ) {
        continue;
      }
      if (!this.hasStateSlot(issue, config)) continue;
      this.dispatch(issue, null);
    }
  }

  availableSlots(config = this.deps.config()): number {
    return Math.max(config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  /** Per-state concurrency override (SPEC §8.3); fallback is the global limit. */
  private hasStateSlot(issue: Issue, config: BatonConfig): boolean {
    const limit = config.agent.maxConcurrentAgentsByState[norm(issue.state)];
    if (limit === undefined) return true;
    let count = 0;
    for (const entry of this.running.values()) {
      if (norm(entry.issue.state) === norm(issue.state)) count++;
    }
    return count < limit;
  }

  dispatch(issue: Issue, attempt: number | null): void {
    const log = this.deps.logger.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    this.claimed.add(issue.id);
    this.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      startedAtMs: this.now(),
      sessionId: null,
      lastEvent: null,
      lastEventAtMs: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      retryAttempt: attempt,
    });
    log.info("dispatching issue", { state: issue.state, attempt });

    Promise.resolve()
      .then(() =>
        this.deps.runWorker(issue, attempt, (event) =>
          this.onAgentUpdate(issue.id, event),
        ),
      )
      .then(
        () => this.onWorkerExit(issue.id, true),
        (err: unknown) => this.onWorkerExit(issue.id, false, err),
      );
  }

  onAgentUpdate(issueId: string, event: AgentEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.lastEvent = event.event;
    entry.lastEventAtMs = this.now();
    if (event.event === "session_started") {
      const sessionId = event.payload?.["session_id"];
      if (typeof sessionId === "string") entry.sessionId = sessionId;
    }
    if (event.usage) {
      entry.inputTokens += event.usage.inputTokens;
      entry.outputTokens += event.usage.outputTokens;
      entry.totalTokens += event.usage.inputTokens + event.usage.outputTokens;
      this.totals.inputTokens += event.usage.inputTokens;
      this.totals.outputTokens += event.usage.outputTokens;
      this.totals.totalTokens +=
        event.usage.inputTokens + event.usage.outputTokens;
    }
  }

  /** Phase 1: release the claim on exit; Phase 2 adds retry scheduling (SPEC §16.6). */
  onWorkerExit(issueId: string, normal: boolean, err?: unknown): void {
    const entry = this.running.get(issueId);
    this.running.delete(issueId);
    this.claimed.delete(issueId);
    if (entry) {
      this.totals.secondsRunning += (this.now() - entry.startedAtMs) / 1000;
    }
    const log = this.deps.logger.child({
      issue_id: issueId,
      issue_identifier: entry?.identifier ?? "",
      ...(entry?.sessionId ? { session_id: entry.sessionId } : {}),
    });
    if (normal) {
      this.completed.add(issueId);
      log.info("worker completed");
    } else {
      log.error("worker failed", { error: String(err) });
    }
  }
}
