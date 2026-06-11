import type { Logger } from "../observability/logger.js";
import type { Issue } from "../tracker/types.js";
import type { RetryState, Scheduler } from "./orchestrator.js";

export interface RetryManagerDeps {
  scheduler: Scheduler;
  now: () => number;
  logger: Logger;
}

/**
 * Owns the pending-retry timers (SPEC §8.4): the issue→RetryState map and the
 * scheduler-backed timer mechanics. It is deliberately decision-free — arming,
 * cancelling, and snapshotting only. The orchestrator keeps the redispatch
 * logic (slot checks, claim release) and calls {@link arm}/{@link take}.
 */
export class RetryManager {
  private readonly map = new Map<string, RetryState>();

  constructor(private readonly deps: RetryManagerDeps) {}

  /** Number of armed retries (used by the snapshot and tests). */
  get size(): number {
    return this.map.size;
  }

  /** Iterate the armed RetryState entries (for snapshot building). */
  [Symbol.iterator](): IterableIterator<RetryState> {
    return this.map.values();
  }

  /**
   * Arm a retry timer for an issue, replacing any existing one. `fire` runs when
   * the timer elapses (the orchestrator wires this to its retry handler).
   */
  arm(
    issue: Issue,
    promptAttempt: number | null,
    failureAttempt: number,
    delayMs: number,
    fire: () => void,
  ): void {
    this.map.get(issue.id)?.task.cancel();
    const task = this.deps.scheduler(fire, delayMs);
    this.map.set(issue.id, {
      issue,
      promptAttempt,
      failureAttempt,
      task,
      scheduledAtMs: this.deps.now(),
      delayMs,
    });
    this.deps.logger.info("retry scheduled", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      delay_ms: delayMs,
      attempt: failureAttempt,
    });
  }

  /** Remove and return the armed retry for an issue, if any (timer not cancelled). */
  take(issueId: string): RetryState | undefined {
    const entry = this.map.get(issueId);
    if (entry) this.map.delete(issueId);
    return entry;
  }

  /** Cancel every pending retry timer and clear the map (e.g. on shutdown). */
  cancelAll(): void {
    for (const retry of this.map.values()) retry.task.cancel();
    this.map.clear();
  }
}
