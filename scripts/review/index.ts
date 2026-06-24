#!/usr/bin/env node
import path from "node:path";
import { Liquid } from "liquidjs";
import { ClaudeCodeRunner } from "../../src/agent/claude-code.js";
import { CopilotRunner } from "../../src/agent/copilot.js";
import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
} from "../../src/agent/runner.js";
import type { BatonConfig, TrackerConfig } from "../../src/config/schema.js";
import { Logger } from "../../src/observability/logger.js";
import { ensureGitBashOnWindowsPath } from "../../src/platform/git-bash.js";
import { GitHubProjectsClient } from "../../src/tracker/github-projects.js";
import type { Issue } from "../../src/tracker/types.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import type { ReviewConfig, ReviewTrackerConfig } from "./config.js";
import { loadReviewConfig } from "./config.js";

ensureGitBashOnWindowsPath();

const logger = new Logger({ service: "review" });
const liquid = new Liquid({ strictVariables: true });

function usage(): string {
  return [
    "Usage: tsx scripts/review/index.ts [REVIEW.md]",
    "",
    "Runs a one-shot review pass for issues in the configured active states.",
  ].join("\n");
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "-h" || arg === "--help";
}

function toTrackerConfig(config: ReviewTrackerConfig): TrackerConfig {
  return {
    kind: "github_projects",
    endpoint: "https://api.github.com/graphql",
    token: config.token,
    owner: config.owner,
    ownerType: config.ownerType,
    projectNumber: config.projectNumber,
    statusField: config.statusField,
    priorityField: null,
    repos: config.repos,
    requiredLabels: [],
    activeStates: config.activeStates,
    terminalStates: [],
  };
}

function toWorkspaceManagerConfig(config: ReviewConfig): BatonConfig {
  return {
    tracker: {
      kind: "github_projects",
      endpoint: "https://api.github.com/graphql",
      token: config.tracker.token,
      owner: config.tracker.owner,
      ownerType: config.tracker.ownerType,
      projectNumber: config.tracker.projectNumber,
      statusField: config.tracker.statusField,
      priorityField: null,
      repos: config.tracker.repos,
      requiredLabels: [],
      activeStates: config.tracker.activeStates,
      terminalStates: [],
    },
    polling: { intervalMs: 30000 },
    workspace: { root: config.workspace.root },
    hooks: {
      afterCreate: config.hooks.afterCreate,
      beforeRun: config.hooks.beforeRun,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: config.workspace.hookTimeoutMs,
    },
    agent: {
      kind: config.agent.kind,
      maxConcurrentAgents: config.agent.maxConcurrent,
      maxTurns: 1,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    claudeCode: {
      command: "claude",
      model: config.claudeCode.model,
      permissionMode: config.claudeCode.permissionMode,
      allowedTools: [],
      disallowedTools: config.claudeCode.denyTools,
      appendSystemPrompt: null,
      extraArgs: [],
      turnTimeoutMs: config.agent.timeoutMs,
      stallTimeoutMs: 300000,
    },
    copilot: {
      command: "copilot",
      model: config.copilot.model,
      allowAllTools: config.copilot.allowAllTools,
      allowTools: config.copilot.allowTools,
      denyTools: [],
      extraArgs: [],
      turnTimeoutMs: config.agent.timeoutMs,
      stallTimeoutMs: 300000,
    },
    server: { host: "127.0.0.1", port: null },
  };
}

function createRunner(config: ReviewConfig, runLogger: Logger): AgentRunner {
  if (config.agent.kind === "claude_code") {
    return new ClaudeCodeRunner(
      config.claudeCode,
      runLogger.child({ agent: "claude_code" }),
    );
  }
  return new CopilotRunner(
    config.copilot,
    runLogger.child({ agent: "copilot" }),
  );
}

function logAgentEvent(issueLogger: Logger, event: AgentEvent): void {
  switch (event.event) {
    case "notification":
      if (event.message) {
        issueLogger.info("agent notification", { message: event.message });
      }
      break;
    case "tool_use":
      issueLogger.debug("agent tool use", { tool: event.message });
      break;
    case "turn_completed":
      issueLogger.info("agent turn completed", { usage: event.usage });
      break;
    case "turn_failed":
      issueLogger.warn("agent turn failed", {
        message: event.message ?? null,
      });
      break;
    default:
      issueLogger.debug("agent event", {
        event: event.event,
        message: event.message ?? null,
      });
      break;
  }
}

async function runIssue(
  issue: Issue,
  workspaceManager: WorkspaceManager,
  runner: AgentRunner,
  promptTemplate: string,
  issueLogger: Logger,
): Promise<void> {
  const workspace = await workspaceManager.createForIssue(issue);
  issueLogger.info("workspace ready", { workspace: workspace.path });

  await workspaceManager.runBeforeRun(issue, workspace.path);

  const prompt = await liquid.parseAndRender(promptTemplate, { issue });
  const session = await runner.startSession(workspace.path);

  try {
    const result = await runner.runTurn(session, prompt, (event) => {
      logAgentEvent(issueLogger, event);
    });
    if (!result.ok) {
      throw new Error(result.error ?? "agent run failed");
    }
  } finally {
    await stopSessionQuietly(runner, session, issueLogger);
  }
}

async function stopSessionQuietly(
  runner: AgentRunner,
  session: AgentSession,
  issueLogger: Logger,
): Promise<void> {
  try {
    await runner.stopSession(session);
  } catch (err) {
    issueLogger.error("failed to stop agent session", { error: String(err) });
  }
}

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (isHelpFlag(configArg)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const configPath = configArg ?? path.join(process.cwd(), "REVIEW.md");

  logger.info("loading review config", { path: configPath });
  const { config, promptTemplate } = await loadReviewConfig(configPath);

  if (!config.tracker.token) {
    throw new Error(
      "tracker.token is required — set GITHUB_TOKEN or provide it in REVIEW.md",
    );
  }

  const tracker = new GitHubProjectsClient(toTrackerConfig(config.tracker));
  const workspaceManager = new WorkspaceManager(
    toWorkspaceManagerConfig(config),
    logger,
  );
  const runner = createRunner(config, logger);

  logger.info("fetching issues", {
    owner: config.tracker.owner,
    project: config.tracker.projectNumber,
    active_states: config.tracker.activeStates,
  });

  const issues = await tracker.fetchIssuesByStates(config.tracker.activeStates);
  logger.info("fetched issues", { issue_count: issues.length });

  let successCount = 0;
  let failureCount = 0;

  for (const issue of issues) {
    const issueLogger = logger.child({ issue: issue.identifier });
    try {
      await runIssue(
        issue,
        workspaceManager,
        runner,
        promptTemplate,
        issueLogger,
      );
      successCount++;
    } catch (err) {
      failureCount++;
      issueLogger.error("review failed", { error: String(err) });
    }
  }

  logger.info("review complete", {
    success: successCount,
    failed: failureCount,
    total: issues.length,
  });

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error("review failed", { error: String(err) });
  process.exit(1);
});
