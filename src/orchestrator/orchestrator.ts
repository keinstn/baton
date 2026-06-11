import type { AgentEvent } from "../agent/runner.js";
import type { BatonConfig, ValidationResult } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { Issue } from "../tracker/types.js";
import { norm } from "../util.js";
import { CONTINUATION_DELAY_MS, failureBackoffMs } from "./retry.js";

/** Why the orchestrator intentionally stopped a running worker (SPEC §8.5). */
export type StopReason = "stall" | "reconcile_terminal" | "reconcile_inactive";

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
  /** Consecutive failure count carried into this run (0 = fresh/clean). */
  failureAttempt: number;
  /** Cancels the run; reconciliation/stall trip this (SPEC §8.5). */
  abort: AbortController;
  /** Set before aborting so the worker-exit handler knows it was intentional. */
  stopReason: StopReason | null;
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
  signal: AbortSignal,
) => Promise<void>;

/** A pending retry timer that can be cancelled (SPEC §8.4). */
export interface ScheduledTask {
  cancel(): void;
}

/** Injectable timer so tests can fire retries deterministically. */
export type Scheduler = (fn: () => void, delayMs: number) => ScheduledTask;

const defaultScheduler: Scheduler = (fn, delayMs) => {
  const t = setTimeout(fn, delayMs);
  return { cancel: () => clearTimeout(t) };
};

interface RetryState {
  issue: Issue;
  /** Prompt attempt passed to the worker when this retry re-dispatches. */
  promptAttempt: number | null;
  failureAttempt: number;
  task: ScheduledTask;
}

export interface OrchestratorDeps {
  tracker: {
    fetchCandidateIssues(): Promise<Issue[]>;
    fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  };
  runWorker: RunWorker;
  validate: () => ValidationResult;
  /** Getter so Phase 2 hot reload can swap config between ticks. */
  config: () => BatonConfig;
  logger: Logger;
  now?: () => number;
  /** Defaults to setTimeout-backed scheduling; injected in tests. */
  scheduler?: Scheduler;
  /** Remove a terminal issue's workspace during reconciliation (SPEC §8.5). */
  cleanupWorkspace?: (issue: Issue) => Promise<void>;
}

/** Runner stall timeout for the configured agent kind; `<= 0` disables it (SPEC §8.5). */
export function stallTimeoutMsFor(config: BatonConfig): number {
  return config.agent.kind === "copilot"
    ? config.copilot.stallTimeoutMs
    : config.claudeCode.stallTimeoutMs;
}

/** Terminal = the underlying issue is CLOSED or its state is a terminal state (SPEC §8.5). */
export function isIssueTerminal(issue: Issue, config: BatonConfig): boolean {
  if (issue.closed) return true;
  const s = norm(issue.state);
  return config.tracker.terminalStates.some((t) => norm(t) === s);
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

/**
 * Whether an issue still belongs to Baton's active set (SPEC §8.2/§8.5): open,
 * in an active (non-terminal) state, passing the repos filter, and carrying
 * every required label. Used both for dispatch eligibility and to decide
 * whether a running issue should keep working during reconciliation.
 */
export function isIssueActive(issue: Issue, config: BatonConfig): boolean {
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
  return true;
}

/** Candidate eligibility (SPEC §8.2), excluding concurrency-slot checks. */
export function isDispatchEligible(
  issue: Issue,
  config: BatonConfig,
  state: { running: ReadonlySet<string>; claimed: ReadonlySet<string> },
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state)
    return false;
  if (!isIssueActive(issue, config)) return false;

  if (state.running.has(issue.id) || state.claimed.has(issue.id)) return false;

  // Blocker rule applies to the first active state ("Todo" by default).
  const firstActive = norm(config.tracker.activeStates[0] ?? "todo");
  if (
    norm(issue.state) === firstActive &&
    issue.blockedBy.some((b) => !b.terminal)
  )
    return false;

  return true;
}

/**
 * Poll-tick orchestrator (SPEC §7-8). Single authority for dispatch state.
 *
 * Each tick: reconcile running issues (stall + tracker refresh) → preflight
 * validation → fetch candidates → sort → dispatch with global/per-state
 * concurrency. Clean worker exits schedule a ~1s continuation retry; failures
 * and stalls schedule an exponential-backoff retry (SPEC §8.1, §8.4, §8.5).
 */
export class Orchestrator {
  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly completed = new Set<string>();
  readonly retries = new Map<string, RetryState>();
  readonly totals: AgentTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };

  private ticking = false;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? defaultScheduler;
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

    // SPEC §8.1: reconcile running issues before dispatching.
    await this.reconcile();

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

  /**
   * Active-run reconciliation (SPEC §8.5). Part A: kill workers stalled past the
   * runner's `stall_timeout_ms`. Part B: refresh tracker state for running issues
   * — terminal/closed ⇒ stop (and clean workspace); no longer active ⇒ stop;
   * still active ⇒ update snapshot; refresh failure ⇒ keep workers, retry later.
   */
  async reconcile(): Promise<void> {
    const config = this.deps.config();
    const log = this.deps.logger;

    // Part A — stall detection.
    const stallMs = stallTimeoutMsFor(config);
    if (stallMs > 0) {
      for (const [id, entry] of this.running) {
        if (entry.stopReason) continue;
        const last = entry.lastEventAtMs ?? entry.startedAtMs;
        if (this.now() - last > stallMs) {
          log.warn("run stalled; cancelling", {
            issue_id: id,
            issue_identifier: entry.identifier,
            elapsed_ms: this.now() - last,
          });
          this.stopRunning(entry, "stall");
        }
      }
    }

    // Part B — tracker state refresh.
    const ids = [...this.running.entries()]
      .filter(([, e]) => !e.stopReason)
      .map(([id]) => id);
    if (ids.length === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.deps.tracker.fetchIssueStatesByIds(ids);
    } catch (err) {
      // SPEC §8.5: refresh failure keeps workers running; retry next tick.
      log.error("reconciliation refresh failed; keeping workers", {
        error: String(err),
      });
      return;
    }
    const byId = new Map(refreshed.map((i) => [i.id, i]));
    for (const id of ids) {
      const entry = this.running.get(id);
      if (!entry || entry.stopReason) continue;
      const latest = byId.get(id);
      if (!latest) continue; // missing from refresh → keep, re-check next tick
      if (isIssueTerminal(latest, config)) {
        entry.issue = latest;
        this.stopRunning(entry, "reconcile_terminal");
      } else if (!isIssueActive(latest, config)) {
        entry.issue = latest;
        this.stopRunning(entry, "reconcile_inactive");
      } else {
        entry.issue = latest; // SPEC §8.5: update snapshot, keep working
      }
    }
  }

  /** Mark and cancel a running worker; the exit handler applies the reason. */
  private stopRunning(entry: RunningEntry, reason: StopReason): void {
    entry.stopReason = reason;
    entry.abort.abort();
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

  dispatch(issue: Issue, attempt: number | null, failureAttempt = 0): void {
    const log = this.deps.logger.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    const abort = new AbortController();
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
      failureAttempt,
      abort,
      stopReason: null,
    });
    log.info("dispatching issue", { state: issue.state, attempt });

    Promise.resolve()
      .then(() =>
        this.deps.runWorker(
          issue,
          attempt,
          (event) => this.onAgentUpdate(issue.id, event),
          abort.signal,
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

  /**
   * Worker exit handler (SPEC §16.6). An intentional stop (reconciliation/stall)
   * takes priority over the normal/failure distinction: terminal/inactive stops
   * release the claim (terminal also cleans the workspace), stalls become a
   * backoff retry. Otherwise a clean exit schedules a continuation retry and a
   * failure schedules an exponential-backoff retry.
   */
  onWorkerExit(issueId: string, normal: boolean, err?: unknown): void {
    const entry = this.running.get(issueId);
    this.running.delete(issueId);
    if (entry) {
      this.totals.secondsRunning += (this.now() - entry.startedAtMs) / 1000;
    }
    const log = this.deps.logger.child({
      issue_id: issueId,
      issue_identifier: entry?.identifier ?? "",
      ...(entry?.sessionId ? { session_id: entry.sessionId } : {}),
    });

    const reason = entry?.stopReason ?? null;
    if (reason === "reconcile_terminal" || reason === "reconcile_inactive") {
      this.claimed.delete(issueId);
      if (
        reason === "reconcile_terminal" &&
        entry &&
        this.deps.cleanupWorkspace
      ) {
        const issue = entry.issue;
        void this.deps.cleanupWorkspace(issue).catch((e: unknown) => {
          log.warn("workspace cleanup failed", { error: String(e) });
        });
      }
      log.info("worker stopped by reconciliation", { reason });
      return;
    }

    if (normal && reason === null) {
      this.completed.add(issueId);
      log.info("worker completed");
      // SPEC §7.1/§8.4: re-check shortly whether the issue is still active.
      if (entry) this.scheduleContinuationRetry(entry.issue);
      return;
    }

    // Failure or stall → exponential-backoff retry (SPEC §8.4).
    const nextAttempt = (entry?.failureAttempt ?? 0) + 1;
    log.error("worker failed", {
      error: String(err),
      ...(reason ? { reason } : {}),
      attempt: nextAttempt,
    });
    if (entry) this.scheduleFailureRetry(entry.issue, nextAttempt);
  }

  /** Schedule a fixed ~1s continuation retry after a clean exit (SPEC §8.4). */
  private scheduleContinuationRetry(issue: Issue): void {
    this.armRetry(issue, null, 0, CONTINUATION_DELAY_MS);
  }

  /** Schedule an exponential-backoff retry after a failure/stall (SPEC §8.4). */
  private scheduleFailureRetry(issue: Issue, failureAttempt: number): void {
    const cap = this.deps.config().agent.maxRetryBackoffMs;
    const delay = failureBackoffMs(failureAttempt, cap);
    this.armRetry(issue, failureAttempt, failureAttempt, delay);
  }

  /** Keep the issue claimed and arm a retry timer (replacing any existing one). */
  private armRetry(
    issue: Issue,
    promptAttempt: number | null,
    failureAttempt: number,
    delayMs: number,
  ): void {
    this.retries.get(issue.id)?.task.cancel();
    this.claimed.add(issue.id); // stay claimed so the tick won't double-dispatch
    const task = this.scheduler(() => this.onRetryTimer(issue.id), delayMs);
    this.retries.set(issue.id, { issue, promptAttempt, failureAttempt, task });
    this.deps.logger.info("retry scheduled", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      delay_ms: delayMs,
      attempt: failureAttempt,
    });
  }

  /**
   * Retry timer fired (SPEC §8.4/§16.6): fetch active candidates, release the
   * claim if the issue disappeared or went inactive, requeue on slot exhaustion,
   * otherwise re-dispatch carrying the failure-attempt count.
   */
  async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.retries.get(issueId);
    if (!retry) return;
    this.retries.delete(issueId);
    const log = this.deps.logger.child({
      issue_id: issueId,
      issue_identifier: retry.issue.identifier,
    });

    let candidates: Issue[];
    try {
      candidates = await this.deps.tracker.fetchCandidateIssues();
    } catch (err) {
      // Treat a fetch failure like slot exhaustion: requeue and try later.
      log.error("retry candidate fetch failed; requeuing", {
        error: String(err),
      });
      this.requeue(retry);
      return;
    }

    const config = this.deps.config();
    const found = candidates.find((i) => i.id === issueId);
    if (!found || !isIssueActive(found, config)) {
      this.claimed.delete(issueId);
      log.info("retry: issue no longer active; releasing claim");
      return;
    }

    // The claim is ours; clear it so dispatch's slot/eligibility math is clean.
    this.claimed.delete(issueId);
    if (this.availableSlots(config) <= 0 || !this.hasStateSlot(found, config)) {
      log.error("no available orchestrator slots; requeuing retry");
      this.requeue({ ...retry, issue: found });
      return;
    }
    this.dispatch(found, retry.promptAttempt, retry.failureAttempt);
  }

  /** Re-arm a retry that could not run yet (slot exhaustion / fetch failure). */
  private requeue(retry: RetryState): void {
    this.armRetry(
      retry.issue,
      retry.promptAttempt,
      retry.failureAttempt,
      CONTINUATION_DELAY_MS,
    );
  }

  /** Cancel all pending retry timers (e.g. on shutdown). */
  cancelRetries(): void {
    for (const retry of this.retries.values()) retry.task.cancel();
    this.retries.clear();
  }
}
