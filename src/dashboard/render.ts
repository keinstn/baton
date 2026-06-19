import { DASHBOARD_CSS } from "../observability/dashboard.js";
import { he } from "../observability/http-util.js";
import type { DashboardTarget } from "./config.js";

/** Produce JSON safe for embedding inside a <script> block: escape <, >, &. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function renderDashboardPage(targets: DashboardTarget[]): string {
  const targetsJson = scriptSafeJson(
    targets.map((t) => ({ name: t.name, url: t.url })),
  );

  // Inline card HTML for each target is built client-side; we just embed a
  // placeholder container per target so the page has stable anchors.
  const targetCards = targets
    .map(
      (t) =>
        `<div class="instance-card" id="card-${he(t.name)}" data-name="${he(t.name)}">
  <div class="instance-header">
    <span class="instance-name">${he(t.name)}</span>
    <span class="instance-url">${he(t.url)}</span>
    <span class="instance-status" id="status-${he(t.name)}">…</span>
  </div>
  <div class="instance-body" id="body-${he(t.name)}">Loading…</div>
</div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Baton — dashboard</title>
<style>${DASHBOARD_CSS}
.instance-card { background: var(--bg-surface); border: 1px solid var(--border);
  border-top: 2px solid var(--accent-dim); margin-bottom: 1.5rem; padding: 1rem; }
.instance-header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 0.75rem;
  border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
.instance-name { font-weight: bold; color: var(--accent); font-size: 1rem; }
.instance-url { font-size: 0.8rem; color: var(--text-muted); }
.instance-status { margin-left: auto; font-size: 0.8rem; font-weight: bold; }
.status-up { color: #00e5ff; }
.status-down { color: #ff4444; }
.aggregated { background: var(--bg-surface); border: 1px solid var(--accent-dim);
  padding: 1rem; margin-bottom: 2rem; }
.aggregated h2 { color: var(--accent); margin-bottom: 0.75rem; }
</style>
</head>
<body>
<header>
  <div class="logo">Baton</div>
  <div class="tagline">multi-instance dashboard</div>
</header>
<p class="meta">Fetched at <code id="fetched-at">—</code></p>

<div class="aggregated">
  <h2>Aggregated Totals</h2>
  <div class="stats-grid" id="agg-grid">
    <div class="stat-card"><div class="stat-label">Instances</div><div class="stat-value" id="agg-instances">—</div></div>
    <div class="stat-card"><div class="stat-label">Running</div><div class="stat-value" id="agg-running">—</div></div>
    <div class="stat-card"><div class="stat-label">Retrying</div><div class="stat-value" id="agg-retrying">—</div></div>
    <div class="stat-card"><div class="stat-label">Total tokens</div><div class="stat-value" id="agg-tokens">—</div></div>
  </div>
</div>

${targetCards}

<script>
const TARGETS = ${targetsJson};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTable(rows, cols, renderRow) {
  if (!rows || rows.length === 0) return '<p class="empty">none</p>';
  const head = cols.map(c => \`<th>\${c}</th>\`).join("");
  const body = rows.map(renderRow).join("");
  return \`<table><thead><tr>\${head}</tr></thead><tbody>\${body}</tbody></table>\`;
}

function renderRunning(rows) {
  return renderTable(
    rows,
    ["Issue", "Title", "State", "Turns", "Session", "Last event", "Started", "Tokens"],
    r => \`<tr>
      <td>\${r.issue_url ? \`<a href="\${esc(r.issue_url)}">\${esc(r.identifier)}</a>\` : esc(r.identifier)}</td>
      <td>\${esc(r.title)}</td>
      <td>\${esc(r.state ?? "")}</td>
      <td class="num">\${r.turn_count}</td>
      <td><code>\${esc(r.session_id ?? "—")}</code></td>
      <td>\${esc(r.last_event ?? "—")}</td>
      <td>\${esc(r.started_at)}</td>
      <td class="num">\${r.total_tokens ?? 0}</td>
    </tr>\`
  );
}

function renderRetrying(rows) {
  return renderTable(
    rows,
    ["Issue", "Title", "Attempt", "Scheduled", "Fires", "Delay (ms)"],
    r => \`<tr>
      <td>\${r.issue_url ? \`<a href="\${esc(r.issue_url)}">\${esc(r.identifier)}</a>\` : esc(r.identifier)}</td>
      <td>\${esc(r.title)}</td>
      <td class="num">\${r.attempt}</td>
      <td>\${esc(r.scheduled_at)}</td>
      <td>\${esc(r.fires_at)}</td>
      <td class="num">\${r.delay_ms}</td>
    </tr>\`
  );
}

async function fetchAll() {
  document.getElementById("fetched-at").textContent = new Date().toISOString();
  const results = await Promise.allSettled(
    TARGETS.map(t =>
      fetch(t.url + "/api/v1/state")
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then(data => ({ target: t, data }))
    )
  );

  let aggRunning = 0, aggRetrying = 0, aggTokens = 0, aggUp = 0;

  results.forEach((result, i) => {
    const t = TARGETS[i];
    const statusEl = document.getElementById("status-" + t.name);
    const bodyEl = document.getElementById("body-" + t.name);

    if (result.status === "fulfilled") {
      const snap = result.value.data;
      const runCount = (snap.running || []).length;
      const retryCount = (snap.retrying || []).length;
      const tokens = (snap.agent_totals || {}).total_tokens || 0;

      aggUp++;
      aggRunning += runCount;
      aggRetrying += retryCount;
      aggTokens += tokens;

      statusEl.textContent = "up";
      statusEl.className = "instance-status status-up";

      bodyEl.innerHTML =
        \`<div class="stats-grid" style="margin-bottom:1rem">
          <div class="stat-card"><div class="stat-label">Running</div><div class="stat-value">\${runCount}</div></div>
          <div class="stat-card"><div class="stat-label">Retrying</div><div class="stat-value">\${retryCount}</div></div>
          <div class="stat-card"><div class="stat-label">Input tokens</div><div class="stat-value">\${(snap.agent_totals || {}).input_tokens || 0}</div></div>
          <div class="stat-card"><div class="stat-label">Total tokens</div><div class="stat-value">\${tokens}</div></div>
        </div>
        <div class="section-header"><h2>Running</h2><span class="badge badge-running">\${runCount}</span></div>
        \${renderRunning(snap.running || [])}
        <div class="section-header" style="margin-top:1rem"><h2>Retrying</h2><span class="badge badge-retry">\${retryCount}</span></div>
        \${renderRetrying(snap.retrying || [])}\`;
    } else {
      statusEl.textContent = "down";
      statusEl.className = "instance-status status-down";
      bodyEl.innerHTML = \`<p class="empty">Error: \${esc(String(result.reason))}</p>\`;
    }
  });

  document.getElementById("agg-instances").textContent = aggUp + " / " + TARGETS.length;
  document.getElementById("agg-running").textContent = String(aggRunning);
  document.getElementById("agg-retrying").textContent = String(aggRetrying);
  document.getElementById("agg-tokens").textContent = String(aggTokens);
}

fetchAll();
</script>
</body>
</html>
`;
}
