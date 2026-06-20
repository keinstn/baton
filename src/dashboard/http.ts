import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  exact,
  sendError,
  sendMethodNotAllowed,
} from "../observability/http-util.js";
import type { DashboardTarget } from "./config.js";
import { renderDashboardPage } from "./render.js";

export interface DashboardHttpDeps {
  host: string;
  port: number;
  targets: DashboardTarget[];
}

export interface RunningDashboardServer {
  port: number;
  close(): Promise<void>;
}

export function startDashboardServer(
  deps: DashboardHttpDeps,
): Promise<RunningDashboardServer> {
  const html = renderDashboardPage(deps.targets);

  const server = createServer((req, res) => {
    handleRequest(req, res, html).catch((err: unknown) => {
      if (!res.headersSent)
        sendError(res, 500, "internal_error", "internal error");
      void err;
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const resolvedPort =
        typeof addr === "object" && addr !== null ? addr.port : deps.port;
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  html: string,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const path = url.split("?", 1)[0] ?? "/";

  const params = exact("/")(path);
  if (params !== null) {
    if (method !== "GET" && method !== "HEAD") {
      return sendMethodNotAllowed(res, ["GET", "HEAD"]);
    }
    return sendHtml(res, html, method === "HEAD");
  }

  return sendError(res, 404, "not_found", `no resource at ${path}`);
}

function sendHtml(res: ServerResponse, html: string, headOnly: boolean): void {
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
