#!/usr/bin/env node
import { buildConfig, validateDispatchConfig } from "./config/schema.js";
import { loadWorkflow } from "./workflow/loader.js";
import { Logger } from "./observability/logger.js";
import { GitHubProjectsClient } from "./tracker/github-projects.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { ClaudeCodeRunner } from "./agent/claude-code.js";
import { createWorker } from "./orchestrator/worker.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { isBatonError } from "./errors.js";

async function main(): Promise<void> {
  const logger = new Logger({ service: "baton" });
  const workflowPath = process.argv[2] ?? "./WORKFLOW.md";

  // SPEC §17.7: error cleanly on a missing workflow file.
  const workflow = await loadWorkflow(workflowPath);
  const config = buildConfig(workflow.config, workflow.dir);

  // SPEC §6.3: startup validation failure fails startup.
  const validation = validateDispatchConfig(config);
  if (!validation.ok) {
    for (const err of validation.errors) {
      logger.error("startup validation failed", { code: err.code, detail: err.message });
    }
    process.exitCode = 1;
    return;
  }
  if (config.agent.kind !== "claude_code") {
    logger.error("agent kind not implemented in Phase 1", { kind: config.agent.kind });
    process.exitCode = 1;
    return;
  }

  const tracker = new GitHubProjectsClient(config.tracker, fetch, logger);
  const workspaces = new WorkspaceManager(config, logger);
  const runner = new ClaudeCodeRunner(config.claudeCode, logger);
  const orchestrator = new Orchestrator({
    tracker,
    runWorker: createWorker({
      workspaces,
      runner,
      promptTemplate: () => workflow.promptTemplate,
      logger,
    }),
    validate: () => validateDispatchConfig(config),
    config: () => config,
    logger,
  });

  logger.info("baton started", {
    workflow: workflow.path,
    project: `${config.tracker.owner}/#${config.tracker.projectNumber}`,
    poll_interval_ms: config.polling.intervalMs,
    max_concurrent_agents: config.agent.maxConcurrentAgents,
  });

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const scheduleTick = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await orchestrator.tick();
      scheduleTick(config.polling.intervalMs);
    }, delayMs);
  };
  scheduleTick(0); // SPEC §8.1: immediate first tick.

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    stopped = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg = isBatonError(err) ? `${err.code}: ${err.message}` : String(err);
  process.stderr.write(JSON.stringify({ level: "error", msg }) + "\n");
  process.exit(1);
});
