import type { IssueDecision } from "./evaluator.js";

export function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

export function parseDecisions(text: string): IssueDecision[] {
  const clean = stripCodeFence(text);
  const parsed: unknown = JSON.parse(clean);
  if (!Array.isArray(parsed)) {
    throw new Error("eval: expected JSON array of IssueDecision");
  }
  const decisions = parsed as IssueDecision[];
  for (const d of decisions) {
    if (typeof d.number !== "number") {
      throw new Error(
        `eval: decision.number must be a number, got ${JSON.stringify(d.number)}`,
      );
    }
  }
  return decisions;
}
