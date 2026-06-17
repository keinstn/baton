#!/usr/bin/env node
import { isBatonError } from "../errors.js";
import { Logger } from "../observability/logger.js";
import { parseDashboardArgs } from "./cli-args.js";
import { loadDashboardConfig } from "./config.js";
import { startDashboardServer } from "./http.js";
import { createPoller } from "./poller.js";

async function main(): Promise<void> {
  const logger = new Logger({ service: "baton-dashboard" });
  const args = parseDashboardArgs(process.argv.slice(2));

  const config = await loadDashboardConfig(args.configPath);

  const effectivePort = args.port ?? config.server.port;
  const poller = createPoller({ config });

  const server = await startDashboardServer({
    host: config.server.host,
    port: effectivePort,
    boards: () => poller.boards(),
    totals: () => poller.totals(),
    logger,
  });

  poller.start();

  logger.info("baton-dashboard started", {
    config: args.configPath,
    port: server.port,
    targets: config.targets.length,
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    poller.stop();
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg = isBatonError(err) ? `${err.code}: ${err.message}` : String(err);
  process.stderr.write(`${JSON.stringify({ level: "error", msg })}\n`);
  process.exit(1);
});
