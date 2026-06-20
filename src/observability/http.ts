import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { OrchestratorSnapshot } from "../orchestrator/orchestrator.js";
import { renderDashboard } from "./dashboard.js";
import {
  exact,
  pattern,
  sendError,
  sendJson,
  sendMethodNotAllowed,
} from "./http-util.js";
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

interface RouteContext {
  res: ServerResponse;
  deps: HttpServerDeps;
  method: string;
  /** Capture groups from the route pattern (empty for exact-path routes). */
  params: string[];
}

interface Route {
  /** Return capture groups when `path` matches this route, else null. */
  match(path: string): string[] | null;
  /** Methods this route serves; anything else yields 405 + Allow. */
  methods: string[];
  handle(ctx: RouteContext): void;
}

/**
 * Route table, matched top-to-bottom. The exact `/api/v1/state` and
 * `/api/v1/refresh` routes precede the `/api/v1/<identifier>` pattern, so they
 * win for those paths (a wrong method on them yields 405, not a fall-through).
 */
const routes: Route[] = [
  {
    match: exact("/"),
    methods: ["GET", "HEAD"],
    handle: ({ res, deps, method }) =>
      sendDashboard(res, deps.snapshot(), method === "HEAD"),
  },
  {
    match: exact("/api/v1/state"),
    methods: ["GET", "HEAD"],
    handle: ({ res, deps, method }) => {
      sendJson(res, 200, deps.snapshot(), method === "HEAD");
    },
  },
  {
    match: exact("/api/v1/refresh"),
    methods: ["POST"],
    handle: ({ res, deps }) => {
      deps.refresh();
      sendJson(res, 202, { accepted: true });
    },
  },
  {
    match: pattern(/^\/api\/v1\/([^/]+)$/),
    methods: ["GET", "HEAD"],
    handle: handleIdentifier,
  },
];

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  // Parse path only; query string is unused (observability/control surface).
  const path = url.split("?", 1)[0] ?? "/";

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.statusCode = 204;
    res.end();
    return;
  }

  for (const route of routes) {
    const params = route.match(path);
    if (!params) continue;
    if (!route.methods.includes(method)) {
      return sendMethodNotAllowed(res, route.methods);
    }
    return route.handle({ res, deps, method, params });
  }

  return sendError(res, 404, "not_found", `no resource at ${path}`);
}

/** `GET /api/v1/<identifier>`: the running/retrying entry for one issue. */
function handleIdentifier({ res, deps, method, params }: RouteContext): void {
  let identifier: string;
  try {
    identifier = decodeURIComponent(params[0] as string);
  } catch {
    sendError(res, 400, "bad_request", "malformed identifier in path");
    return;
  }
  const snap = deps.snapshot();
  const running = snap.running.find((r) => r.identifier === identifier);
  const retrying = snap.retrying.find((r) => r.identifier === identifier);
  if (!running && !retrying) {
    sendError(
      res,
      404,
      "not_found",
      `no running or retrying entry for ${identifier}`,
    );
    return;
  }
  sendJson(
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
