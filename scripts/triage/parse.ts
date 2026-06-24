import type { IssueDecision } from "./evaluator.js";

export function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

// Scan for the first balanced outermost [...] in text; try each candidate in
// order until one parses as valid JSON. Returns text unchanged as fallback.
function extractJsonArray(text: string): string {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i, j + 1);
            try {
              JSON.parse(candidate);
              return candidate;
            } catch {
              break;
            }
          }
        }
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return text;
}

export function parseDecisions(text: string): IssueDecision[] {
  const clean = stripCodeFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // LLMs sometimes emit conversational preamble/postamble around the JSON array
    parsed = JSON.parse(extractJsonArray(clean));
  }
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
