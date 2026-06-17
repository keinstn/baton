import {
  DASHBOARD_CSS,
  escapeHtml,
  renderRetryingTable,
  renderRunningTable,
} from "../observability/dashboard.js";
import type {
  SnapshotRetrying,
  SnapshotRunning,
} from "../orchestrator/orchestrator.js";
import type { BoardState } from "./config.js";
import type { AggregatedTotals } from "./poller.js";

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function normalizeRunningEntry(v: unknown): SnapshotRunning | null {
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

function normalizeRetryingEntry(v: unknown): SnapshotRetrying | null {
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

function parseSnapshot(
  v: unknown,
): { running: SnapshotRunning[]; retrying: SnapshotRetrying[] } | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.running) || !Array.isArray(s.retrying)) return null;
  return {
    running: (s.running as unknown[])
      .map(normalizeRunningEntry)
      .filter((e): e is SnapshotRunning => e !== null),
    retrying: (s.retrying as unknown[])
      .map(normalizeRetryingEntry)
      .filter((e): e is SnapshotRetrying => e !== null),
  };
}

function renderBoardSection(board: BoardState): string {
  const snap =
    board.up && board.snapshot ? parseSnapshot(board.snapshot) : null;
  const upBadge = board.up
    ? `<span class="badge badge-up">UP</span>`
    : `<span class="badge badge-down">DOWN</span>`;
  const lastScraped = board.lastScrapedAt
    ? escapeHtml(board.lastScrapedAt.toISOString())
    : "never";
  const errorInfo = board.error
    ? `<p class="error-msg">${escapeHtml(board.error)}</p>`
    : "";
  const running: SnapshotRunning[] = snap ? snap.running : [];
  const retrying: SnapshotRetrying[] = snap ? snap.retrying : [];

  return `<section class="board-section">
  <div class="section-header">
    <h2>${escapeHtml(board.name)}</h2>
    ${upBadge}
    <span class="board-url"><a href="${escapeHtml(board.url)}">${escapeHtml(board.url)}</a></span>
    <span class="last-scraped">last scraped: ${lastScraped}</span>
  </div>
  ${errorInfo}
  <div class="board-subsection">
    <div class="section-header">
      <h3>Running</h3>
      <span class="badge badge-running">${running.length}</span>
    </div>
    ${renderRunningTable(running)}
  </div>
  <div class="board-subsection">
    <div class="section-header">
      <h3>Retrying</h3>
      <span class="badge badge-retry">${retrying.length}</span>
    </div>
    ${renderRetryingTable(retrying)}
  </div>
</section>`;
}

export function renderMultiBoardDashboard(
  boards: BoardState[],
  totals: AggregatedTotals,
  generatedAt: string,
): string {
  const boardSections = boards.map(renderBoardSection).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Baton — dashboard</title>
<style>${DASHBOARD_CSS}
  .board-section { margin-bottom: 3rem; border: 1px solid var(--border); padding: 1rem; }
  .board-subsection { margin-top: 1rem; margin-bottom: 1rem; }
  h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent-dim); }
  .board-url { font-size: 0.8rem; color: var(--text-muted); }
  .last-scraped { font-size: 0.8rem; color: var(--text-muted); }
  .badge-up { background: #00cc66; color: #000; font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 2px; font-weight: bold; }
  .badge-down { background: #cc3333; color: #fff; font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 2px; font-weight: bold; }
  .error-msg { color: #cc3333; font-size: 0.85rem; margin: 0.5rem 0; }
</style>
</head>
<body>
<header>
  <div class="logo">Baton</div>
  <div class="tagline">dashboard</div>
</header>
<p class="meta">Generated at <code>${escapeHtml(generatedAt)}</code> — auto-refresh every 5s.</p>

<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-label">Running</div>
    <div class="stat-value">${totals.running}</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Retrying</div>
    <div class="stat-value">${totals.retrying}</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Total tokens</div>
    <div class="stat-value">${totals.total_tokens}</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Seconds running</div>
    <div class="stat-value">${totals.seconds_running.toFixed(1)}</div>
  </div>
</div>

${boardSections}
</body>
</html>
`;
}
