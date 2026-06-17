import {
  DASHBOARD_CSS,
  escapeHtml,
  renderRetryingTable,
  renderRunningTable,
} from "../observability/dashboard.js";
import type { OrchestratorSnapshot } from "../orchestrator/orchestrator.js";
import type { BoardState } from "./config.js";
import type { AggregatedTotals } from "./poller.js";

function renderBoardSection(board: BoardState): string {
  const snap =
    board.up && board.snapshot
      ? (board.snapshot as OrchestratorSnapshot)
      : null;
  const upBadge = board.up
    ? `<span class="badge badge-up">UP</span>`
    : `<span class="badge badge-down">DOWN</span>`;
  const lastScraped = board.lastScrapedAt
    ? escapeHtml(board.lastScrapedAt.toISOString())
    : "never";
  const errorInfo = board.error
    ? `<p class="error-msg">${escapeHtml(board.error)}</p>`
    : "";
  const running = snap ? snap.running : [];
  const retrying = snap ? snap.retrying : [];

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
