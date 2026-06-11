import type {
  OrchestratorSnapshot,
  SnapshotRetrying,
  SnapshotRunning,
} from "../orchestrator/orchestrator.js";

/** Escape text for safe interpolation into HTML (XSS prevention, SPEC §13.7). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs become links; blocks javascript:/data: hrefs. */
function isSafeHttpUrl(u: string | null): boolean {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Issue cell: a link when the url is a safe http(s) URL, otherwise plain text. */
function issueCell(identifier: string, url: string | null): string {
  return isSafeHttpUrl(url)
    ? `<a href="${escapeHtml(url as string)}">${escapeHtml(identifier)}</a>`
    : escapeHtml(identifier);
}

function renderRunningTable(rows: SnapshotRunning[]): string {
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

function renderRetryingTable(rows: SnapshotRetrying[]): string {
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

/** Render the self-refreshing status dashboard HTML for `GET /` (SPEC §13.7). */
export function renderDashboard(snap: OrchestratorSnapshot): string {
  const totals = snap.agent_totals;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Baton — orchestrator status</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem; color: #222; }
  h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
  h2 { margin: 1.5rem 0 0.5rem; font-size: 1.1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #eee; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f7f7f7; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #888; font-style: italic; }
  .muted { color: #666; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
</style>
</head>
<body>
<h1>Baton</h1>
<p class="muted">Generated at <code>${escapeHtml(snap.generated_at)}</code> — auto-refresh every 5s.</p>

<h2>Totals</h2>
<table>
  <tr><th>Input tokens</th><td class="num">${totals.input_tokens}</td></tr>
  <tr><th>Output tokens</th><td class="num">${totals.output_tokens}</td></tr>
  <tr><th>Total tokens</th><td class="num">${totals.total_tokens}</td></tr>
  <tr><th>Seconds running</th><td class="num">${totals.seconds_running.toFixed(1)}</td></tr>
</table>

<h2>Running (${snap.running.length})</h2>
${renderRunningTable(snap.running)}

<h2>Retrying (${snap.retrying.length})</h2>
${renderRetryingTable(snap.retrying)}
</body>
</html>
`;
}
