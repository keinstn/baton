import type { BatonConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { ClaudeCodeRunner } from "./claude-code.js";
import { CopilotRunner } from "./copilot.js";
import type { AgentRunner } from "./runner.js";
import { makeTreeKiller, type TreeKiller } from "./tree-killer.js";

export interface RunnerHandle {
  runner: AgentRunner;
  /** Re-apply the relevant config section after a hot-reload (SPEC §6.2). */
  applyReloadedConfig: (config: BatonConfig) => void;
}

/**
 * Select and construct the agent runner for the configured kind, returning a
 * handle that also knows how to re-apply its own config section on reload. This
 * keeps runner selection in one place and frees callers from `instanceof`
 * branching when hot-reloading config.
 */
export function createRunner(
  config: BatonConfig,
  logger?: Logger,
  treeKiller: TreeKiller = makeTreeKiller(),
): RunnerHandle {
  if (config.agent.kind === "copilot") {
    const runner = new CopilotRunner(config.copilot, logger, treeKiller);
    return {
      runner,
      applyReloadedConfig: (next) => runner.applyConfig(next.copilot),
    };
  }
  const runner = new ClaudeCodeRunner(config.claudeCode, logger, treeKiller);
  return {
    runner,
    applyReloadedConfig: (next) => runner.applyConfig(next.claudeCode),
  };
}
