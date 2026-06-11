import type {
  AgentTotals,
  OrchestratorSnapshot,
  RetryState,
  RunningEntry,
  SnapshotRetrying,
  SnapshotRunning,
} from "./orchestrator.js";

/** Read-only view of orchestrator state the snapshot is derived from. */
export interface SnapshotState {
  running: ReadonlyMap<string, RunningEntry>;
  retries: Iterable<RetryState>;
  totals: AgentTotals;
}

/**
 * Build a JSON-serializable snapshot of orchestrator state for the OPTIONAL
 * HTTP server extension (SPEC §13.7). Pure and read-only: it copies the live
 * maps into plain objects so callers cannot mutate state and concurrent ticks
 * don't expose partial updates. Live elapsed seconds for in-flight runs are
 * folded into `agent_totals.seconds_running` (SPEC §13.5).
 */
export function buildSnapshot(
  state: SnapshotState,
  nowMs: number,
): OrchestratorSnapshot {
  let liveElapsedSec = 0;
  for (const entry of state.running.values()) {
    liveElapsedSec += (nowMs - entry.startedAtMs) / 1000;
  }

  const running: SnapshotRunning[] = [];
  for (const entry of state.running.values()) {
    running.push({
      identifier: entry.identifier,
      issue_id: entry.issue.id,
      issue_url: entry.issue.url,
      title: entry.issue.title,
      state: entry.issue.state,
      turn_count: entry.turnCount,
      session_id: entry.sessionId,
      started_at: new Date(entry.startedAtMs).toISOString(),
      last_event: entry.lastEvent,
      last_event_at:
        entry.lastEventAtMs === null
          ? null
          : new Date(entry.lastEventAtMs).toISOString(),
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      total_tokens: entry.totalTokens,
      retry_attempt: entry.retryAttempt,
      failure_attempt: entry.failureAttempt,
    });
  }

  const retrying: SnapshotRetrying[] = [];
  for (const retry of state.retries) {
    retrying.push({
      identifier: retry.issue.identifier,
      issue_id: retry.issue.id,
      issue_url: retry.issue.url,
      title: retry.issue.title,
      attempt: retry.failureAttempt,
      prompt_attempt: retry.promptAttempt,
      scheduled_at: new Date(retry.scheduledAtMs).toISOString(),
      fires_at: new Date(retry.scheduledAtMs + retry.delayMs).toISOString(),
      delay_ms: retry.delayMs,
    });
  }

  return {
    generated_at: new Date(nowMs).toISOString(),
    running,
    retrying,
    agent_totals: {
      input_tokens: state.totals.inputTokens,
      output_tokens: state.totals.outputTokens,
      total_tokens: state.totals.totalTokens,
      seconds_running: state.totals.secondsRunning + liveElapsedSec,
    },
    // SPEC §13.5: present but null when the agent protocol does not expose
    // rate-limit counters (Claude Code SDK and Copilot CLI do not surface them).
    rate_limits: null,
  };
}
