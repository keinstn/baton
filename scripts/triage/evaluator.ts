import { Liquid } from "liquidjs";
import { createClaudeEvaluator } from "./claude-eval.js";
import type { EvaluatorConfig } from "./config.js";
import { createCopilotEvaluator } from "./copilot-eval.js";
import type { TriageIssue } from "./fetcher.js";

export interface IssueDecision {
  number: number;
  decision: "ready" | "not_ready" | "needs_clarification";
  reason: string;
  comment?: string;
}

export interface Evaluator {
  evaluate(
    issues: TriageIssue[],
    promptTemplate: string,
    repository: string,
  ): Promise<IssueDecision[]>;
}

const liquid = new Liquid({ strictVariables: true }); // throws on undefined variables rather than silently rendering empty strings

export async function renderPrompt(
  template: string,
  issues: TriageIssue[],
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
