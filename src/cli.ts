#!/usr/bin/env node
import { watch } from "node:fs";
import path from "node:path";
import { createRunner } from "./agent/factory.js";
import { parseArgs } from "./cli-args.js";
import { buildConfig, validateDispatchConfig } from "./config/schema.js";
import { errorCause, isBatonError } from "./errors.js";
import { startHttpServer } from "./observability/http.js";
import { Logger } from "./observability/logger.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { startupTerminalCleanup } from "./orchestrator/startup.js";
import { createWorker } from "./orchestrator/worker.js";
import { GitHubProjectsClient } from "./tracker/github-projects.js";
import { loadWorkflow } from "./workflow/loader.js";
import { WorkflowReloader } from "./workflow/reloader.js";
import { WorkspaceManager } from "./workspace/manager.js";

async function main(): Promise<void> {
  const logger = new Logger({ service: "baton" });
  const args = parseArgs(process.argv.slice(2));

  // SPEC §17.7: error cleanly on a missing workflow file.
  const workflow = await loadWorkflow(args.workflowPath);
  const config = buildConfig(workflow.config, workflow.dir);

  // SPEC §6.3: startup validation failure fails startup.
  const validation = validateDispatchConfig(config);
  if (!validation.ok) {
    for (const err of validation.errors) {
      logger.error("startup validation failed", {
        code: err.code,
        detail: err.message,
      });
    }
    process.exitCode = 1;
    return;
  }
  if (config.agent.kind !== "claude_code" && config.agent.kind !== "copilot") {
    logger.error("agent kind not supported", {
      kind: config.agent.kind,
    });
    process.exitCode = 1;
    return;
  }

  const tracker = new GitHubProjectsClient(config.tracker, fetch, logger);
  const workspaces = new WorkspaceManager(config, logger);
  const { runner, applyReloadedConfig } = createRunner(config, logger);

  // SPEC §6.2: hot-reload WORKFLOW.md, keeping the last known good config on
  // failure. The orchestrator/worker read config + prompt through these getters,
  // so a successful reload takes effect on the next tick without a restart.
  const reloader = new WorkflowReloader(
    workflow.path,
    { config, promptTemplate: workflow.promptTemplate },
    logger,
    (next) => {
      tracker.applyConfig(next.tracker);
      applyReloadedConfig(next);
      workspaces.applyConfig(next);
    },
  );

  const orchestrator = new Orchestrator({
    tracker,
    runWorker: createWorker({
      workspaces,
      runner,
      tracker,
      config: () => reloader.config(),
      promptTemplate: () => reloader.promptTemplate(),
      logger,
    }),
    validate: () => validateDispatchConfig(reloader.config()),
    config: () => reloader.config(),
    cleanupWorkspace: (issue) => workspaces.cleanup(issue),
    logger,
  });

  // SPEC §13.7 refresh: coalesce concurrent triggers into one out-of-band tick.
  // Polling remains the source of truth, so a missed coalesced refresh is
  // benign — the next polling tick still reconciles.
  let refreshPending = false;
  const triggerRefresh = (): void => {
    if (refreshPending) return;
    refreshPending = true;
    setImmediate(async () => {
      try {
        await orchestrator.tick();
      } catch (err) {
        logger.error("refresh tick failed", {
          error: String(err),
          ...errorCause(err),
        });
      } finally {
        refreshPending = false;
      }
    });
  };

  logger.info("baton started", {
    workflow: workflow.path,
    project: `${config.tracker.owner}/#${config.tracker.projectNumber}`,
    poll_interval_ms: config.polling.intervalMs,
    max_concurrent_agents: config.agent.maxConcurrentAgents,
  });

  // SPEC §8.1/§8.6: startup terminal workspace cleanup before the first tick.
  await startupTerminalCleanup({
    tracker,
    cleanupWorkspace: (issue) => workspaces.cleanup(issue),
    config: () => reloader.config(),
    logger,
  });

  // SPEC §13.7: CLI `--port` wins over `server.port` front matter; HTTP off
  // when neither is set (OPTIONAL extension).
  const effectivePort = args.port ?? config.server.port;
  const httpServer =
    effectivePort !== null
      ? await startHttpServer({
          host: config.server.host,
          port: effectivePort,
          snapshot: () => orchestrator.snapshot(),
          refresh: triggerRefresh,
          logger,
        })
      : null;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const scheduleTick = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await orchestrator.tick();
      scheduleTick(reloader.config().polling.intervalMs);
    }, delayMs);
  };
  scheduleTick(0); // SPEC §8.1: immediate first tick.

  // Watch the containing directory so atomic saves (write-temp + rename) are
  // still detected; debounce bursts of events into a single reload.
  const watchDir = path.dirname(workflow.path);
  const watchBase = path.basename(workflow.path);
  let reloadTimer: NodeJS.Timeout | null = null;
  const watcher = watch(watchDir, (_event, filename) => {
    if (!filename || path.basename(filename.toString()) !== watchBase) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      void reloader.reload();
    }, 100);
  });
  watcher.on("error", (err) => {
    logger.error("workflow watch error", {
      error: String(err),
      ...errorCause(err),
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    stopped = true;
    if (timer) clearTimeout(timer);
    orchestrator.cancelRetries();
    if (reloadTimer) clearTimeout(reloadTimer);
    watcher.close();
    void httpServer?.close().catch(() => {
      /* ignore close errors during shutdown */
    });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg = isBatonError(err) ? `${err.code}: ${err.message}` : String(err);
  process.stderr.write(`${JSON.stringify({ level: "error", msg })}\n`);
  process.exit(1);
});
