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

/** Format seconds as HH:MM:SS for uptime display. */
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function renderRunningCards(rows: SnapshotRunning[]): string {
  if (rows.length === 0) return `<p class="empty">none</p>`;
  return rows
    .map(
      (r) => `<div class="card">
  <div class="card-body">
    <div class="card-top">
      <span class="c-id">${issueCell(r.identifier, r.issue_url)}</span>
      <span class="c-title">${escapeHtml(r.title)}</span>
      <span class="c-state">${escapeHtml(r.state ?? "running")}</span>
    </div>
    <div class="card-bot">
      <span class="c-event">${escapeHtml(r.last_event ?? "—")}</span>
      <span class="c-sep">·</span>
      <span class="c-sess">${escapeHtml(r.session_id ?? "—")}</span>
      <span class="c-sep">·</span>
      <span class="c-event">started ${escapeHtml(r.started_at)}</span>
    </div>
  </div>
  <div class="card-side">
    <div class="side-metric"><div class="side-val">${r.turn_count}</div><div class="side-lbl">turns</div></div>
    <div class="side-metric"><div class="side-val">${r.total_tokens.toLocaleString()}</div><div class="side-lbl">tokens</div></div>
  </div>
</div>`,
    )
    .join("\n");
}

function renderRetryingCards(rows: SnapshotRetrying[]): string {
  if (rows.length === 0) return `<p class="empty">none</p>`;
  return rows
    .map(
      (r) => `<div class="card retry">
  <div class="card-body">
    <div class="card-top">
      <span class="c-id">${issueCell(r.identifier, r.issue_url)}</span>
      <span class="c-title">${escapeHtml(r.title)}</span>
      <span class="c-state">Retrying</span>
    </div>
    <div class="card-bot">
      <span class="c-event">fires at ${escapeHtml(r.fires_at)}</span>
      <span class="c-sep">·</span>
      <span class="c-event">delay ${r.delay_ms.toLocaleString()} ms</span>
      <span class="c-sep">·</span>
      <span class="c-event">sched ${escapeHtml(r.scheduled_at)}</span>
    </div>
  </div>
  <div class="card-side">
    <div class="side-metric"><div class="side-val">${r.attempt}</div><div class="side-lbl">attempt</div></div>
  </div>
</div>`,
    )
    .join("\n");
}

export const DASHBOARD_CSS = `
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
    --num:          #79c0ff;
    --code:         #56d364;
    --mono: "JetBrains Mono","Cascadia Code","Fira Code",ui-monospace,monospace;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes bar-enter { from{transform:scaleX(0)} to{transform:scaleX(1)} }

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
  .op-badge { display:flex; align-items:center; gap:.4rem; font: 700 .72rem/1 var(--mono); color:var(--green); letter-spacing:.06em; }
  .op-dot { width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2.4s infinite; }
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

  .token-total { font: 800 1.35rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; margin-bottom:.5rem; }
  .bar-track { height:3px; border-radius:2px; overflow:hidden; background:var(--border-hi); margin-bottom:.5rem; display:flex; }
  .bar-in  { height:100%; background:var(--cyan);  transform-origin:left; animation:bar-enter .5s ease both .1s; }
  .bar-out { height:100%; background:var(--amber); transform-origin:left; animation:bar-enter .5s ease both .25s; }
  .legend  { display:flex; flex-direction:column; gap:.3rem; }
  .legend-row { display:flex; justify-content:space-between; align-items:center; }
  .legend-key { display:flex;align-items:center;gap:.35rem; font-size:.72rem; color:var(--muted2); }
  .legend-dot { width:5px;height:5px;border-radius:50%; }
  .legend-val { font:.72rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; }

  .uptime-val { font: 700 1.1rem/1 var(--mono); color:var(--text); font-variant-numeric:tabular-nums; }
  .uptime-sub { font:.65rem/1 var(--mono); color:var(--muted); margin-top:.3rem; }

  .main { flex:1; min-height:0; overflow-y:auto; padding:1.25rem 1.5rem; display:flex; flex-direction:column; gap:1.75rem; }

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

/** Render the self-refreshing status dashboard HTML for `GET /` (SPEC §13.7). */
export function renderDashboard(snap: OrchestratorSnapshot): string {
  const t = snap.agent_totals;
  const inputPct =
    t.total_tokens > 0
      ? Math.round((t.input_tokens / t.total_tokens) * 100)
      : 0;
  const outputPct = 100 - inputPct;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Baton — orchestrator status</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="topbar">
  <div class="logo">
    <span>BATON</span>
    <span class="logo-slash">/</span>
    <span class="logo-sub">orchestrator</span>
  </div>
  <div class="topbar-spacer"></div>
  <div class="op-badge"><span class="op-dot"></span>operational</div>
  <div class="td"></div>
  <div class="topbar-ts">${escapeHtml(snap.generated_at)} · refresh 5s</div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div>
      <div class="sb-eyebrow">Agents</div>
      <div class="big-num">${snap.running.length}</div>
      <div class="big-lbl">running</div>
      <div class="big-sub"><span class="big-sub-dot"></span>${snap.retrying.length} retrying</div>
    </div>

    <div>
      <div class="sb-eyebrow">Token Burn</div>
      <div class="token-total">${t.total_tokens.toLocaleString()}</div>
      <div class="bar-track">
        <div class="bar-in"  style="width:${inputPct}%"></div>
        <div class="bar-out" style="width:${outputPct}%"></div>
      </div>
      <div class="legend">
        <div class="legend-row">
          <div class="legend-key"><div class="legend-dot" style="background:var(--cyan)"></div>input</div>
          <div class="legend-val">${t.input_tokens.toLocaleString()}</div>
        </div>
        <div class="legend-row">
          <div class="legend-key"><div class="legend-dot" style="background:var(--amber)"></div>output</div>
          <div class="legend-val">${t.output_tokens.toLocaleString()}</div>
        </div>
      </div>
    </div>

    <div>
      <div class="sb-eyebrow">Uptime</div>
      <div class="uptime-val">${formatUptime(t.seconds_running)}</div>
      <div class="uptime-sub">refresh every 5s</div>
    </div>
  </aside>

  <main class="main">
    <div>
      <div class="section-label">Running <span class="sl-count run">${snap.running.length}</span></div>
      <div class="card-list">
        ${renderRunningCards(snap.running)}
      </div>
    </div>
    <div>
      <div class="section-label">Retrying <span class="sl-count retry">${snap.retrying.length}</span></div>
      <div class="card-list">
        ${renderRetryingCards(snap.retrying)}
      </div>
    </div>
  </main>
</div>
</body>
</html>
`;
}
