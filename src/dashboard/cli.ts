#!/usr/bin/env node
import { parseDashboardArgs } from "./cli-args.js";
import { loadDashboardConfig } from "./config.js";
import { startDashboardServer } from "./http.js";

async function main(): Promise<void> {
  const args = parseDashboardArgs(process.argv.slice(2));
  const config = await loadDashboardConfig(args.configPath);
  const effectivePort = args.port ?? config.server.port;

  const server = await startDashboardServer({
    host: config.server.host,
    port: effectivePort,
    targets: config.targets,
  });

  const addr = `http://${config.server.host}:${server.port}`;
  process.stderr.write(
    `${JSON.stringify({ level: "info", msg: "baton-dashboard listening", url: addr })}\n`,
  );

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ level: "error", msg })}\n`);
  process.exit(1);
});
