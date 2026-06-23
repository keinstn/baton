import { escapeHtml as he } from "../observability/dashboard.js";
import type { DashboardTarget } from "./config.js";

/** Produce JSON safe for embedding inside a <script> block: escape <, >, &. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

const MULTI_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:           #080b0f;
    --surface:      #0d1117;
    --surface-hi:   #111820;
    --border:       #1a2332;
    --border-hi:    #243040;
    --text:         #c9d1d9;
    --muted:        #4a5568;
    --muted2:       #718096;
    --cyan:         #00e5ff;
    --cyan-dim:     rgba(0,229,255,0.08);
    --cyan-border:  rgba(0,229,255,0.2);
    --amber:        #ffcc00;
    --amber-dim:    rgba(255,204,0,0.08);
    --amber-border: rgba(255,204,0,0.2);
    --green:        #00ff88;
    --red:          #ff6b6b;
    --num:          #79c0ff;
    --code:         #56d364;
    --mono: "JetBrains Mono","Cascadia Code","Fira Code",ui-monospace,monospace;
  }
  @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes bar-enter{ from{transform:scaleX(0)} to{transform:scaleX(1)} }

  html,body { height:100%; background:var(--bg); color:var(--text); }
  body { display:flex; flex-direction:column; min-height:100vh; font: 17px/1.5 var(--mono); }

  .topbar {
    height:48px; background:var(--surface); border-bottom:1px solid var(--border-hi);
    display:flex; align-items:center; padding:0 1.25rem; gap:.75rem; flex-shrink:0;
  }
  .logo { font: 800 1rem/1 var(--mono); color:#fff; letter-spacing:.14em; text-transform:uppercase; }
  .logo-slash { color:var(--border-hi); margin:0 .15rem; font-weight:400; }
  .logo-sub   { font: 400 .78rem/1 var(--mono); color:var(--muted2); letter-spacing:.08em; }
  .topbar-spacer { flex:1; }
  .topbar-ts { font: .72rem/1 var(--mono); color:var(--muted); }
  .td { width:1px;height:16px;background:var(--border-hi); }

  .layout { display:flex; flex:1; overflow:hidden; }

  .sidebar {
    width:196px; background:var(--surface); border-right:1px solid var(--border);
    padding:1.25rem 1rem; flex-shrink:0;
    display:flex; flex-direction:column; gap:1.5rem; overflow-y:auto;
  }
  .sb-eyebrow { font: 700 .63rem/1 var(--mono); text-transform:uppercase; letter-spacing:.18em; color:var(--muted); margin-bottom:.75rem; }
  .big-num { font: 800 2.6rem/1 var(--mono); color:var(--cyan); font-variant-numeric:tabular-nums; }
  .big-lbl { font-size:.8rem; color:var(--muted2); margin-top:.2rem; }
  .big-sub { display:flex;align-items:center;gap:.3rem; font:.72rem/1 var(--mono); color:var(--amber); margin-top:.45rem; }
  .big-sub-dot { width:4px;height:4px;border-radius:50%;background:var(--amber); }

  .sb-stat { display:flex; justify-content:space-between; align-items:baseline; padding:.3rem 0; border-bottom:1px solid var(--border); }
  .sb-stat:last-child { border-bottom:none; }
  .sb-stat-lbl { font:.7rem/1 var(--mono); color:var(--muted2); }
  .sb-stat-val { font: 700 .85rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; }

  .token-total { font: 800 1.35rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; margin-bottom:.5rem; }
  .bar-track { height:3px; border-radius:2px; overflow:hidden; background:var(--border-hi); margin-bottom:.5rem; display:flex; }
  .bar-in  { height:100%; background:var(--cyan);  transform-origin:left; animation:bar-enter .5s ease both .1s; }
  .bar-out { height:100%; background:var(--amber); transform-origin:left; animation:bar-enter .5s ease both .25s; }
  .legend  { display:flex; flex-direction:column; gap:.3rem; }
  .legend-row { display:flex; justify-content:space-between; align-items:center; }
  .legend-key { display:flex;align-items:center;gap:.35rem; font-size:.72rem; color:var(--muted2); }
  .legend-dot { width:5px;height:5px;border-radius:50%; }
  .legend-val { font:.72rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; }

  .main { flex:1; min-height:0; overflow-y:auto; padding:1.25rem 1.5rem; display:flex; flex-direction:column; gap:1rem; }

  /* flex-shrink:0 prevents the flex container from clipping card content */
  .instance-card {
    background:var(--surface); border:1px solid var(--border); border-radius:6px;
    overflow:hidden; flex-shrink:0;
  }
  .inst-header {
    display:flex; align-items:center; gap:.75rem;
    padding:.65rem 1rem; border-bottom:1px solid var(--border);
    background:rgba(0,0,0,.25);
  }
  .inst-name { font: 700 .85rem/1 var(--mono); color:var(--text); }
  .inst-url  { font: .7rem/1 var(--mono); color:var(--muted2); }
  .inst-header-spacer { flex:1; }
  .status-badge { font: 700 .65rem/1 var(--mono); text-transform:uppercase; letter-spacing:.08em; padding:.15rem .5rem; border-radius:3px; }
  .status-up      { background:rgba(0,255,136,0.12); color:var(--green); border:1px solid rgba(0,255,136,0.25); }
  .status-down    { background:rgba(255,107,107,0.12); color:var(--red); border:1px solid rgba(255,107,107,0.25); }
  .status-loading { background:var(--cyan-dim); color:var(--muted2); border:1px solid var(--border); }

  .inst-body { padding:1rem; display:flex; flex-direction:column; gap:1rem; }

  .mini-stats { display:flex; gap:.5rem; flex-wrap:wrap; }
  .mini-stat  { background:var(--bg); border:1px solid var(--border); border-radius:3px; padding:.35rem .65rem; }
  .mini-stat-val { font: 700 1rem/1 var(--mono); color:var(--cyan); font-variant-numeric:tabular-nums; }
  .mini-stat-lbl { font:.6rem/1 var(--mono); text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin-top:.2rem; }

  .section-label {
    font: 700 .63rem/1 var(--mono); text-transform:uppercase; letter-spacing:.2em;
    color:var(--muted); margin-bottom:.6rem;
    display:flex; align-items:center; gap:.6rem;
  }
  .section-label::after { content:''; flex:1; height:1px; background:var(--border); }
  .sl-count { font: 700 .63rem/1 var(--mono); padding:.15rem .45rem; border-radius:2px; line-height:1.6; }
  .sl-count.run   { background:var(--cyan-dim);  color:var(--cyan);  border:1px solid var(--cyan-border); }
  .sl-count.retry { background:var(--amber-dim); color:var(--amber); border:1px solid var(--amber-border); }

  .card-list { display:flex; flex-direction:column; gap:4px; }

  .card {
    background:var(--surface); border:1px solid var(--border);
    border-radius:4px; overflow:hidden; position:relative;
    display:grid; grid-template-columns:1fr auto;
    transition:border-color .12s, background .12s;
  }
  .card:hover { border-color:var(--border-hi); background:var(--surface-hi); }
  .card::before { content:''; position:absolute; left:0;top:0;bottom:0; width:3px; background:var(--cyan); border-radius:4px 0 0 4px; }
  .card.retry::before { background:var(--amber); }

  .card-body { padding:.6rem .85rem .6rem 1rem; min-width:0; }
  .card-side {
    padding:.6rem 1rem; border-left:1px solid var(--border); background:rgba(0,0,0,.2);
    display:flex; flex-direction:column; justify-content:center; align-items:flex-end; gap:.3rem; min-width:120px;
  }

  .card-top { display:flex; align-items:baseline; gap:.65rem; min-width:0; margin-bottom:.25rem; flex-wrap:nowrap; }
  .c-id { font: 700 .8rem/1 var(--mono); color:var(--cyan); white-space:nowrap; flex-shrink:0; }
  .c-id a { color:inherit; text-decoration:none; }
  .c-id a:hover { text-decoration:underline; }
  .card.retry .c-id { color:var(--amber); }
  .c-title { font:.85rem/1.3 var(--mono); font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
  .c-state {
    font: 700 .6rem/1 var(--mono); text-transform:uppercase; letter-spacing:.06em;
    padding:.12rem .4rem; border-radius:2px; white-space:nowrap; flex-shrink:0;
    background:var(--cyan-dim); color:var(--cyan); border:1px solid var(--cyan-border);
  }
  .card.retry .c-state { background:var(--amber-dim); color:var(--amber); border-color:var(--amber-border); }

  .card-bot { display:flex; align-items:center; gap:.45rem; }
  .c-event { font:.72rem/1 var(--mono); color:var(--muted2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .c-sep   { color:var(--border-hi); font-size:.7rem; }
  .c-sess  { font:.7rem/1 var(--mono); color:var(--code); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:130px; }

  .side-metric { text-align:right; }
  .side-val { font: 800 .9rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; }
  .side-lbl { font: .58rem/1 var(--mono); text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin-top:.15rem; }

  .empty { font-size:.75rem; color:var(--muted); font-style:italic; padding:.5rem 0; }
  a { color:var(--cyan); text-decoration:none; } a:hover { text-decoration:underline; }
`;

export function renderDashboardPage(targets: DashboardTarget[]): string {
  const targetsJson = scriptSafeJson(
    targets.map((t) => ({ name: t.name, url: t.url })),
  );

  const instanceCards = targets
    .map(
      (t) =>
        `<div class="instance-card" id="card-${he(t.name)}">
  <div class="inst-header">
    <div class="inst-name">${he(t.name)}</div>
    <div class="inst-url">${he(t.url)}</div>
    <div class="inst-header-spacer"></div>
    <div class="status-badge status-loading" id="badge-${he(t.name)}">…</div>
  </div>
  <div class="inst-body" id="body-${he(t.name)}"><p class="empty">Loading…</p></div>
</div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Baton — dashboard</title>
<style>${MULTI_CSS}</style>
</head>
<body>
<div class="topbar">
  <div class="logo">
    <span>BATON</span>
    <span class="logo-slash">/</span>
    <span class="logo-sub">dashboard</span>
  </div>
  <div class="topbar-spacer"></div>
  <div class="topbar-ts" id="fetched-at">—</div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div>
      <div class="sb-eyebrow">Instances</div>
      <div class="big-num" id="agg-up">—</div>
      <div class="big-lbl" id="agg-total">of ${targets.length}</div>
      <div class="big-sub" id="agg-down-row" style="display:none">
        <span class="big-sub-dot"></span><span id="agg-down">0</span> down
      </div>
    </div>

    <div>
      <div class="sb-eyebrow">Activity</div>
      <div class="sb-stat"><span class="sb-stat-lbl">running</span><span class="sb-stat-val" id="agg-running">—</span></div>
      <div class="sb-stat"><span class="sb-stat-lbl">retrying</span><span class="sb-stat-val" id="agg-retrying">—</span></div>
    </div>

    <div>
      <div class="sb-eyebrow">Token Burn</div>
      <div class="token-total" id="agg-tokens">—</div>
      <div class="bar-track">
        <div class="bar-in"  id="bar-in"  style="width:50%"></div>
        <div class="bar-out" id="bar-out" style="width:50%"></div>
      </div>
      <div class="legend">
        <div class="legend-row">
          <div class="legend-key"><div class="legend-dot" style="background:var(--cyan)"></div>input</div>
          <div class="legend-val" id="agg-input">—</div>
        </div>
        <div class="legend-row">
          <div class="legend-key"><div class="legend-dot" style="background:var(--amber)"></div>output</div>
          <div class="legend-val" id="agg-output">—</div>
        </div>
      </div>
    </div>
  </aside>

  <main class="main">
    ${instanceCards}
  </main>
</div>

<script>
const TARGETS = ${targetsJson};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") ? url : null;
  } catch (_) {
    return null;
  }
}

function renderRunning(rows) {
  if (!rows || rows.length === 0) return '<p class="empty">none</p>';
  return rows.map(function(r) {
    var href = r.issue_url ? safeHref(r.issue_url) : null;
    var idHtml = href
      ? '<a href="' + esc(href) + '">' + esc(r.identifier) + '</a>'
      : esc(r.identifier);
    return '<div class="card">' +
      '<div class="card-body">' +
        '<div class="card-top">' +
          '<span class="c-id">' + idHtml + '</span>' +
          '<span class="c-title">' + esc(r.title) + '</span>' +
          '<span class="c-state">' + esc(r.state || "running") + '</span>' +
        '</div>' +
        '<div class="card-bot">' +
          '<span class="c-event">' + esc(r.last_event || "—") + '</span>' +
          '<span class="c-sep">·</span>' +
          '<span class="c-sess">' + esc(r.session_id || "—") + '</span>' +
          '<span class="c-sep">·</span>' +
          '<span class="c-event">started ' + esc(r.started_at) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-side">' +
        '<div class="side-metric"><div class="side-val">' + (r.turn_count || 0) + '</div><div class="side-lbl">turns</div></div>' +
        '<div class="side-metric"><div class="side-val">' + (r.total_tokens || 0) + '</div><div class="side-lbl">tokens</div></div>' +
      '</div>' +
    '</div>';
  }).join("");
}

function renderRetrying(rows) {
  if (!rows || rows.length === 0) return '<p class="empty">none</p>';
  return rows.map(function(r) {
    var href = r.issue_url ? safeHref(r.issue_url) : null;
    var idHtml = href
      ? '<a href="' + esc(href) + '">' + esc(r.identifier) + '</a>'
      : esc(r.identifier);
    return '<div class="card retry">' +
      '<div class="card-body">' +
        '<div class="card-top">' +
          '<span class="c-id">' + idHtml + '</span>' +
          '<span class="c-title">' + esc(r.title) + '</span>' +
          '<span class="c-state">retrying</span>' +
        '</div>' +
        '<div class="card-bot">' +
          '<span class="c-event">fires at ' + esc(r.fires_at) + '</span>' +
          '<span class="c-sep">·</span>' +
          '<span class="c-event">delay ' + (r.delay_ms || 0) + ' ms</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-side">' +
        '<div class="side-metric"><div class="side-val">' + (r.attempt || 0) + '</div><div class="side-lbl">attempt</div></div>' +
      '</div>' +
    '</div>';
  }).join("");
}

async function fetchAll() {
  var tsEl = document.getElementById("fetched-at");
  if (tsEl) tsEl.textContent = new Date().toISOString();

  var results = await Promise.allSettled(
    TARGETS.map(function(t) {
      return fetch(t.url + "/api/v1/state")
        .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
        .then(function(data) { return { target: t, data: data }; });
    })
  );

  var aggUp = 0, aggRunning = 0, aggRetrying = 0, aggTokens = 0, aggInput = 0, aggOutput = 0;

  results.forEach(function(result, i) {
    var t = TARGETS[i];
    var badgeEl = document.getElementById("badge-" + t.name);
    var bodyEl  = document.getElementById("body-"  + t.name);

    if (result.status === "fulfilled") {
      try {
        var snap = result.value.data || {};
        var running  = Array.isArray(snap.running)  ? snap.running  : [];
        var retrying = Array.isArray(snap.retrying) ? snap.retrying : [];
        var totals   = snap.agent_totals && typeof snap.agent_totals === "object" ? snap.agent_totals : {};
        var tokens  = Number.isFinite(+totals.total_tokens)  ? +totals.total_tokens  : 0;
        var input   = Number.isFinite(+totals.input_tokens)  ? +totals.input_tokens  : 0;
        var output  = Number.isFinite(+totals.output_tokens) ? +totals.output_tokens : 0;

        aggUp++;
        aggRunning  += running.length;
        aggRetrying += retrying.length;
        aggTokens   += tokens;
        aggInput    += input;
        aggOutput   += output;

        if (badgeEl) { badgeEl.textContent = "up"; badgeEl.className = "status-badge status-up"; }
        if (bodyEl) {
          bodyEl.innerHTML =
            '<div class="mini-stats">' +
              '<div class="mini-stat"><div class="mini-stat-val">' + running.length + '</div><div class="mini-stat-lbl">running</div></div>' +
              '<div class="mini-stat"><div class="mini-stat-val">' + retrying.length + '</div><div class="mini-stat-lbl">retrying</div></div>' +
              '<div class="mini-stat"><div class="mini-stat-val">' + tokens + '</div><div class="mini-stat-lbl">tokens</div></div>' +
            '</div>' +
            '<div>' +
              '<div class="section-label">Running <span class="sl-count run">' + running.length + '</span></div>' +
              '<div class="card-list">' + renderRunning(running) + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="section-label">Retrying <span class="sl-count retry">' + retrying.length + '</span></div>' +
              '<div class="card-list">' + renderRetrying(retrying) + '</div>' +
            '</div>';
        }
      } catch (e) {
        if (badgeEl) { badgeEl.textContent = "err"; badgeEl.className = "status-badge status-down"; }
        if (bodyEl) bodyEl.innerHTML = '<p class="empty">Render error: ' + esc(String(e)) + '</p>';
      }
    } else {
      if (badgeEl) { badgeEl.textContent = "down"; badgeEl.className = "status-badge status-down"; }
      if (bodyEl) bodyEl.innerHTML = '<p class="empty">Error: ' + esc(String(result.reason)) + '</p>';
    }
  });

  var upEl = document.getElementById("agg-up");
  if (upEl) upEl.textContent = String(aggUp);
  var downRow = document.getElementById("agg-down-row");
  var downEl  = document.getElementById("agg-down");
  var down = TARGETS.length - aggUp;
  if (downRow) downRow.style.display = down > 0 ? "flex" : "none";
  if (downEl)  downEl.textContent = String(down);
  var runEl = document.getElementById("agg-running");
  if (runEl) runEl.textContent = String(aggRunning);
  var retEl = document.getElementById("agg-retrying");
  if (retEl) retEl.textContent = String(aggRetrying);
  var tokEl = document.getElementById("agg-tokens");
  if (tokEl) tokEl.textContent = aggTokens.toLocaleString();
  var inEl  = document.getElementById("agg-input");
  if (inEl)  inEl.textContent  = aggInput.toLocaleString();
  var outEl = document.getElementById("agg-output");
  if (outEl) outEl.textContent = aggOutput.toLocaleString();
  var barIn  = document.getElementById("bar-in");
  var barOut = document.getElementById("bar-out");
  if (barIn && barOut && aggTokens > 0) {
    var inPct  = Math.round(aggInput / aggTokens * 100);
    barIn.style.width  = inPct + "%";
    barOut.style.width = (100 - inPct) + "%";
  }
}

fetchAll();
setInterval(fetchAll, 30000);
</script>
</body>
</html>
`;
}
