import type {
  OrchestratorSnapshot,
  SnapshotRetrying,
  SnapshotRunning,
} from "../orchestrator/orchestrator.js";

/** Escape text for safe interpolation into HTML (XSS prevention, SPEC §13.7). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs become links; blocks javascript:/data: hrefs. */
export function isSafeHttpUrl(u: string | null): boolean {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Issue cell: a link when the url is a safe http(s) URL, otherwise plain text. */
export function issueCell(identifier: string, url: string | null): string {
  return isSafeHttpUrl(url)
    ? `<a href="${escapeHtml(url as string)}">${escapeHtml(identifier)}</a>`
    : escapeHtml(identifier);
}

export function renderRunningTable(rows: SnapshotRunning[]): string {
  if (rows.length === 0) return `<p class="empty">none</p>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${issueCell(r.identifier, r.issue_url)}</td>
        <td>${escapeHtml(r.title)}</td>
        <td>${escapeHtml(r.state ?? "")}</td>
        <td class="num">${r.turn_count}</td>
        <td><code>${escapeHtml(r.session_id ?? "—")}</code></td>
        <td>${escapeHtml(r.last_event ?? "—")}</td>
        <td>${escapeHtml(r.started_at)}</td>
        <td class="num">${r.total_tokens}</td>
      </tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr>
  <th>Issue</th><th>Title</th><th>State</th><th>Turns</th>
  <th>Session</th><th>Last event</th><th>Started</th><th>Tokens</th>
</tr></thead>
<tbody>${body}</tbody></table>`;
}

export function renderRetryingTable(rows: SnapshotRetrying[]): string {
  if (rows.length === 0) return `<p class="empty">none</p>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${issueCell(r.identifier, r.issue_url)}</td>
        <td>${escapeHtml(r.title)}</td>
        <td class="num">${r.attempt}</td>
        <td>${escapeHtml(r.scheduled_at)}</td>
        <td>${escapeHtml(r.fires_at)}</td>
        <td class="num">${r.delay_ms}</td>
      </tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr>
  <th>Issue</th><th>Title</th><th>Attempt</th>
  <th>Scheduled</th><th>Fires</th><th>Delay (ms)</th>
</tr></thead>
<tbody>${body}</tbody></table>`;
}

export const DASHBOARD_CSS = `
  :root {
    --bg: #0d0d0d; --bg-surface: #111111; --bg-header: #002233;
    --bg-row-alt: #0a1520; --border: #1e1e1e;
    --text: #d4d4d4; --text-muted: #555;
    --accent: #00e5ff; --accent-dim: #0099bb;
    --link: #00e5ff; --num: #80d8ff; --code: #40c8e0;
    --badge-running: #00e5ff; --badge-retry: #ffcc00; --indicator: #00e5ff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 15px/1.6 "Courier New","Menlo","Monaco",ui-monospace,monospace;
         background: var(--bg); color: var(--text); min-height: 100vh; padding: 2rem; }
  header { display: flex; align-items: baseline; gap: 1rem;
           border-bottom: 1px solid var(--accent-dim); padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
  .logo { font-size: 1.6rem; font-weight: bold; color: var(--accent);
          letter-spacing: 0.15em; text-transform: uppercase; }
  .tagline { font-size: 0.8rem; color: var(--text-muted); letter-spacing: 0.05em; }
  .meta { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.5rem; }
  .meta code { color: var(--accent-dim); }
  .stats-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 0.75rem; margin-bottom: 2rem; }
  .stat-card { background: var(--bg-surface); border: 1px solid var(--border);
               border-top: 2px solid var(--accent-dim); padding: 0.75rem 1rem; }
  .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;
                letter-spacing: 0.1em; margin-bottom: 0.25rem; }
  .stat-value { font-size: 1.4rem; font-weight: bold; color: var(--accent); font-variant-numeric: tabular-nums; }
  section { margin-bottom: 2rem; }
  .section-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); }
  .badge { font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 2px; font-weight: bold; }
  .badge-running { background: var(--badge-running); color: #000; }
  .badge-retry   { background: var(--badge-retry);   color: #000; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
  th { background: var(--bg-header); color: var(--accent-dim); font-weight: normal;
       text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem;
       padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--accent-dim); text-align: left; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:nth-child(odd) { background: var(--bg-row-alt); }
  tbody tr:hover { background: #001a28; }
  td:first-child { border-left: 3px solid var(--indicator); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--num); }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { color: var(--code); font-size: 0.9em; }
  .empty { color: var(--text-muted); font-style: italic; padding: 0.5rem 0; }
`;

/** Render the self-refreshing status dashboard HTML for `GET /` (SPEC §13.7). */
export function renderDashboard(snap: OrchestratorSnapshot): string {
  const totals = snap.agent_totals;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Baton — orchestrator status</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header>
  <div class="logo">Baton</div>
  <div class="tagline">orchestrator status</div>
</header>
<p class="meta">Generated at <code>${escapeHtml(snap.generated_at)}</code> — auto-refresh every 5s.</p>

<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-label">Input tokens</div>
    <div class="stat-value">${totals.input_tokens}</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Output tokens</div>
    <div class="stat-value">${totals.output_tokens}</div>
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

<section>
  <div class="section-header">
    <h2>Running</h2>
    <span class="badge badge-running">${snap.running.length}</span>
  </div>
  ${renderRunningTable(snap.running)}
</section>

<section>
  <div class="section-header">
    <h2>Retrying</h2>
    <span class="badge badge-retry">${snap.retrying.length}</span>
  </div>
  ${renderRetryingTable(snap.retrying)}
</section>
</body>
</html>
`;
}
