import { Liquid } from "liquidjs";
import type { Issue } from "../../src/tracker/types.js";
import { createClaudeEvaluator } from "./claude-eval.js";
import type { EvaluatorConfig } from "./config.js";
import { createCopilotEvaluator } from "./copilot-eval.js";

export interface IssueDecision {
  number: number;
  decision: "ready" | "not_ready" | "needs_clarification";
  reason: string;
  comment?: string;
}

export interface Evaluator {
  evaluate(
    issues: Issue[],
    promptTemplate: string,
    repository: string,
  ): Promise<IssueDecision[]>;
}

const liquid = new Liquid({ strictVariables: true }); // throws on undefined variables rather than silently rendering empty strings

export async function renderPrompt(
  template: string,
  issues: Issue[],
  repository: string,
): Promise<string> {
  return liquid.parseAndRender(template, { issues, repository });
}

export function createEvaluator(config: EvaluatorConfig): Evaluator {
  if (config.kind === "claude_code") {
    return createClaudeEvaluator(config);
  }
  return createCopilotEvaluator(config);
}
