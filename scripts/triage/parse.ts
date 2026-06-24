import type { IssueDecision } from "./evaluator.js";

export function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

// LLMs sometimes emit conversational preamble/postamble around the JSON array.
// Scan for the first balanced outermost [...] that parses as an array of objects,
// respecting quoted strings so brackets inside string values do not affect depth
// counting and so scalar arrays like [1,2] in prose are not mistaken for the
// decisions array.
function extractJsonArray(text: string): string {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      let depth = 0;
      let j = i;
      let inStr = false;
      let esc = false;
      while (j < text.length) {
        const ch = text[j];
        if (esc) {
          esc = false;
        } else if (inStr) {
          if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === "[") depth++;
          else if (ch === "]") {
            depth--;
            if (depth === 0) {
              const candidate = text.slice(i, j + 1);
              try {
                const arr: unknown = JSON.parse(candidate);
                if (
                  Array.isArray(arr) &&
                  arr.every(
                    (el: unknown) => typeof el === "object" && el !== null,
                  )
                ) {
                  return candidate;
                }
              } catch {
                // not valid JSON, try next candidate
              }
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
  const VALID_DECISIONS = [
    "ready",
    "not_ready",
    "needs_clarification",
  ] as const;
  const decisions = parsed as IssueDecision[];
  for (const d of decisions) {
    if (typeof d.number !== "number") {
      throw new Error(
        `eval: decision.number must be a number, got ${JSON.stringify(d.number)}`,
      );
    }
    if (!VALID_DECISIONS.includes(d.decision as never)) {
      throw new Error(
        `eval: decision.decision must be one of ${VALID_DECISIONS.join("|")}, got ${JSON.stringify(d.decision)}`,
      );
    }
  }
  return decisions;
}
