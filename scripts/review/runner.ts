import { createClaudeReviewRunner } from "./claude-run.js";
import type { ReviewConfig } from "./config.js";
import { createCopilotReviewRunner } from "./copilot-run.js";

export interface ReviewRunner {
  run(workspaceDir: string, prompt: string): Promise<void>;
}

export function createRunner(config: ReviewConfig): ReviewRunner {
  if (config.agent.kind === "copilot") {
    return createCopilotReviewRunner(config);
  }
  return createClaudeReviewRunner(config);
}
