import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  OrchestratorSnapshot,
  SnapshotRetrying,
  SnapshotRunning,
} from "../orchestrator/orchestrator.js";
import type { Logger } from "./logger.js";

export interface HttpServerDeps {
  host: string;
  port: number;
  /** Read-only orchestrator state for `/api/v1/state` and the dashboard. */
  snapshot: () => OrchestratorSnapshot;
  /**
   * Trigger an out-of-band tick (SPEC §13.7 `POST /api/v1/refresh`). The
   * implementation MUST be coalescing — multiple rapid calls collapse to a
   * single tick — and MUST return immediately so the HTTP handler can 202.
   */
  refresh: () => void;
  logger: Logger;
}

export interface RunningHttpServer {
  /** Resolved port (useful when starting on `port: 0` for tests). */
  port: number;
  close(): Promise<void>;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

/**
 * OPTIONAL HTTP server extension (SPEC §13.7). Loopback bind by default,
 * dashboard at `/`, JSON API at `/api/v1/state`, `/api/v1/<identifier>`,
 * `POST /api/v1/refresh` (202 + coalescable). Observability/control only.
 */
export function startHttpServer(
  deps: HttpServerDeps,
): Promise<RunningHttpServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err: unknown) => {
      deps.logger.error("http handler crashed", { error: String(err) });
      if (!res.headersSent)
        sendError(res, 500, "internal_error", "internal error");
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const resolvedPort =
        typeof addr === "object" && addr !== null ? addr.port : deps.port;
      deps.logger.info("http server listening", {
        host: deps.host,
        port: resolvedPort,
      });
      resolve({
        port: resolvedPort,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  // Release idle keep-alive connections first so `server.close()` resolves
  // promptly even when a browser tab or health-check tool is connected.
  // `closeIdleConnections` is available on Node ≥18.2 (engines requires ≥20).
  server.closeIdleConnections();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  // Parse path only; query string is unused (observability/control surface).
  const path = url.split("?", 1)[0] ?? "/";

  if (path === "/") {
    if (method !== "GET" && method !== "HEAD") {
      return sendMethodNotAllowed(res, ["GET", "HEAD"]);
    }
    return sendDashboard(res, deps.snapshot(), method === "HEAD");
  }

  if (path === "/api/v1/state") {
    if (method !== "GET" && method !== "HEAD") {
      return sendMethodNotAllowed(res, ["GET", "HEAD"]);
    }
    return sendJson(res, 200, deps.snapshot(), method === "HEAD");
  }

  if (path === "/api/v1/refresh") {
    if (method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    deps.refresh();
    return sendJson(res, 202, { accepted: true });
  }

  // /api/v1/<identifier>
  const idMatch = /^\/api\/v1\/([^/]+)$/.exec(path);
  if (idMatch) {
    if (method !== "GET" && method !== "HEAD") {
      return sendMethodNotAllowed(res, ["GET", "HEAD"]);
    }
    let identifier: string;
    try {
      identifier = decodeURIComponent(idMatch[1] as string);
    } catch {
      return sendError(res, 400, "bad_request", "malformed identifier in path");
    }
    if (identifier === "state" || identifier === "refresh") {
      // Already handled above; defensive guard.
      return sendError(res, 404, "not_found", `no resource at ${path}`);
    }
    const snap = deps.snapshot();
    const running = snap.running.find((r) => r.identifier === identifier);
    const retrying = snap.retrying.find((r) => r.identifier === identifier);
    if (!running && !retrying) {
      return sendError(
        res,
        404,
        "not_found",
        `no running or retrying entry for ${identifier}`,
      );
    }
    return sendJson(
      res,
      200,
      {
        identifier,
        running: running ?? null,
        retrying: retrying ?? null,
        generated_at: snap.generated_at,
      },
      method === "HEAD",
    );
  }

  return sendError(res, 404, "not_found", `no resource at ${path}`);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headOnly = false,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.setHeader("Cache-Control", "no-store");
  if (headOnly) {
    res.end();
  } else {
    res.end(payload);
  }
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const env: ErrorEnvelope = { error: { code, message } };
  sendJson(res, status, env);
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
  res.setHeader("Allow", allowed.join(", "));
  sendError(
    res,
    405,
    "method_not_allowed",
    `allowed methods: ${allowed.join(", ")}`,
  );
}

function sendDashboard(
  res: ServerResponse,
  snap: OrchestratorSnapshot,
  headOnly: boolean,
): void {
  const html = renderDashboard(snap);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(html).toString());
  res.setHeader("Cache-Control", "no-store");
  if (headOnly) {
    res.end();
  } else {
    res.end(html);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDashboard(snap: OrchestratorSnapshot): string {
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

function isSafeHttpUrl(u: string | null): boolean {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function renderRunningTable(rows: SnapshotRunning[]): string {
  if (rows.length === 0) return `<p class="empty">none</p>`;
  const body = rows
    .map((r) => {
      const link = isSafeHttpUrl(r.issue_url)
        ? `<a href="${escapeHtml(r.issue_url as string)}">${escapeHtml(r.identifier)}</a>`
        : escapeHtml(r.identifier);
      return `<tr>
        <td>${link}</td>
        <td>${escapeHtml(r.title)}</td>
        <td>${escapeHtml(r.state ?? "")}</td>
        <td class="num">${r.turn_count}</td>
        <td><code>${escapeHtml(r.session_id ?? "—")}</code></td>
        <td>${escapeHtml(r.last_event ?? "—")}</td>
        <td>${escapeHtml(r.started_at)}</td>
        <td class="num">${r.total_tokens}</td>
      </tr>`;
    })
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
    .map((r) => {
      const link = isSafeHttpUrl(r.issue_url)
        ? `<a href="${escapeHtml(r.issue_url as string)}">${escapeHtml(r.identifier)}</a>`
        : escapeHtml(r.identifier);
      return `<tr>
        <td>${link}</td>
        <td>${escapeHtml(r.title)}</td>
        <td class="num">${r.attempt}</td>
        <td>${escapeHtml(r.scheduled_at)}</td>
        <td>${escapeHtml(r.fires_at)}</td>
        <td class="num">${r.delay_ms}</td>
      </tr>`;
    })
    .join("\n");
  return `<table>
<thead><tr>
  <th>Issue</th><th>Title</th><th>Attempt</th>
  <th>Scheduled</th><th>Fires</th><th>Delay (ms)</th>
</tr></thead>
<tbody>${body}</tbody></table>`;
}
