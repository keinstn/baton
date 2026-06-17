import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  exact,
  pattern,
  sendError,
  sendJson,
  sendMethodNotAllowed,
} from "../observability/http-util.js";
import type { Logger } from "../observability/logger.js";
import type { BoardState } from "./config.js";
import type { AggregatedTotals } from "./poller.js";
import { renderMultiBoardDashboard } from "./render.js";

export interface DashboardHttpDeps {
  host: string;
  port: number;
  boards: () => BoardState[];
  totals: () => AggregatedTotals;
  /** Injected for testing; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  logger: Logger;
}

export interface RunningDashboardServer {
  /** Resolved port (useful when starting on `port: 0` for tests). */
  port: number;
  close(): Promise<void>;
}

export function startDashboardServer(
  deps: DashboardHttpDeps,
): Promise<RunningDashboardServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err: unknown) => {
      deps.logger.error("dashboard http handler crashed", {
        error: String(err),
      });
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
      deps.logger.info("dashboard http server listening", {
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
  server.closeIdleConnections();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface RouteContext {
  res: ServerResponse;
  deps: DashboardHttpDeps;
  method: string;
  /** Capture groups from the route pattern. */
  params: string[];
}

interface Route {
  match(path: string): string[] | null;
  methods: string[];
  handle(ctx: RouteContext): void | Promise<void>;
}

const routes: Route[] = [
  {
    match: exact("/"),
    methods: ["GET", "HEAD"],
    handle: ({ res, deps, method }) =>
      sendDashboardHtml(res, deps, method === "HEAD"),
  },
  {
    match: exact("/api/v1/boards"),
    methods: ["GET", "HEAD"],
    handle: ({ res, deps, method }) =>
      sendJson(res, 200, deps.boards(), method === "HEAD"),
  },
  {
    match: pattern(/^\/api\/v1\/boards\/([^/]+)\/state$/),
    methods: ["GET", "HEAD"],
    handle: ({ res, deps, method, params }) =>
      handleBoardState(res, deps, params[0] as string, method === "HEAD"),
  },
  {
    match: pattern(/^\/api\/v1\/boards\/([^/]+)\/refresh$/),
    methods: ["POST"],
    handle: ({ res, deps, params }) =>
      handleBoardRefresh(res, deps, params[0] as string),
  },
];

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardHttpDeps,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const path = url.split("?", 1)[0] ?? "/";

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

function sendDashboardHtml(
  res: ServerResponse,
  deps: DashboardHttpDeps,
  headOnly: boolean,
): void {
  const boards = deps.boards();
  const totals = deps.totals();
  const html = renderMultiBoardDashboard(
    boards,
    totals,
    new Date().toISOString(),
  );
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

function handleBoardState(
  res: ServerResponse,
  deps: DashboardHttpDeps,
  encodedName: string,
  headOnly: boolean,
): void {
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    sendError(res, 400, "bad_request", "malformed board name in path");
    return;
  }
  const board = deps.boards().find((b) => b.name === name);
  if (!board) {
    sendError(res, 404, "not_found", `no board named ${name}`);
    return;
  }
  sendJson(res, 200, board, headOnly);
}

async function handleBoardRefresh(
  res: ServerResponse,
  deps: DashboardHttpDeps,
  encodedName: string,
): Promise<void> {
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    sendError(res, 400, "bad_request", "malformed board name in path");
    return;
  }
  const board = deps.boards().find((b) => b.name === name);
  if (!board) {
    sendError(res, 404, "not_found", `no board named ${name}`);
    return;
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const refreshUrl = new URL("/api/v1/refresh", board.url).href;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const proxyRes = await fetchFn(refreshUrl, {
      method: "POST",
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!proxyRes.ok) {
      sendError(
        res,
        502,
        "bad_gateway",
        `upstream refresh returned HTTP ${proxyRes.status}`,
      );
      return;
    }
    sendJson(res, 202, { accepted: true });
  } catch (err) {
    clearTimeout(timer);
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      sendError(res, 504, "gateway_timeout", "upstream refresh timed out");
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 502, "bad_gateway", `upstream refresh failed: ${msg}`);
    }
  }
}
