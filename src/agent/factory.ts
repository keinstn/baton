import type { BatonConfig } from "../config/schema.js";
import { ClaudeCodeRunner } from "./claude-code.js";
import { CopilotRunner } from "./copilot.js";
import type { AgentRunner } from "./runner.js";

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
export function createRunner(config: BatonConfig): RunnerHandle {
  if (config.agent.kind === "copilot") {
    const runner = new CopilotRunner(config.copilot);
    return {
      runner,
      applyReloadedConfig: (next) => runner.applyConfig(next.copilot),
    };
  }
  const runner = new ClaudeCodeRunner(config.claudeCode);
  return {
    runner,
    applyReloadedConfig: (next) => runner.applyConfig(next.claudeCode),
  };
}
