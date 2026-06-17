import type {
  SnapshotRetrying,
  SnapshotRunning,
} from "../orchestrator/orchestrator.js";

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Normalizes a single running-entry payload from an upstream board.
 *
 * Required identity fields must be present or the entry is dropped entirely;
 * optional / malformed fields are coerced to safe fallbacks so one bad row
 * cannot crash the aggregated dashboard or skew totals vs. rendering.
 */
export function normalizeRunningEntry(v: unknown): SnapshotRunning | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.identifier !== "string") return null;
  if (typeof r.title !== "string") return null;
  if (typeof r.started_at !== "string") return null;
  return {
    identifier: r.identifier,
    issue_id: asString(r.issue_id),
    issue_url: typeof r.issue_url === "string" ? r.issue_url : null,
    title: r.title,
    state: typeof r.state === "string" ? r.state : null,
    turn_count: typeof r.turn_count === "number" ? r.turn_count : 0,
    session_id: typeof r.session_id === "string" ? r.session_id : null,
    started_at: r.started_at,
    last_event: typeof r.last_event === "string" ? r.last_event : null,
    last_event_at: typeof r.last_event_at === "string" ? r.last_event_at : null,
    input_tokens: typeof r.input_tokens === "number" ? r.input_tokens : 0,
    output_tokens: typeof r.output_tokens === "number" ? r.output_tokens : 0,
    total_tokens: typeof r.total_tokens === "number" ? r.total_tokens : 0,
    retry_attempt: typeof r.retry_attempt === "number" ? r.retry_attempt : null,
    failure_attempt:
      typeof r.failure_attempt === "number" ? r.failure_attempt : 0,
  };
}

/**
 * Normalizes a single retrying-entry payload from an upstream board.
 *
 * Same defensive contract as `normalizeRunningEntry`: required fields gate
 * inclusion, optional fields fall back to safe defaults.
 */
export function normalizeRetryingEntry(v: unknown): SnapshotRetrying | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.identifier !== "string") return null;
  if (typeof r.title !== "string") return null;
  if (typeof r.scheduled_at !== "string") return null;
  if (typeof r.fires_at !== "string") return null;
  return {
    identifier: r.identifier,
    issue_id: asString(r.issue_id),
    issue_url: typeof r.issue_url === "string" ? r.issue_url : null,
    title: r.title,
    attempt: typeof r.attempt === "number" ? r.attempt : 0,
    prompt_attempt:
      typeof r.prompt_attempt === "number" ? r.prompt_attempt : null,
    scheduled_at: r.scheduled_at,
    fires_at: r.fires_at,
    delay_ms: typeof r.delay_ms === "number" ? r.delay_ms : 0,
  };
}
