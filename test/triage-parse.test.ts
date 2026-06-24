import { describe, expect, it } from "vitest";
import { parseDecisions, stripCodeFence } from "../scripts/triage/parse.js";

describe("stripCodeFence", () => {
  it("removes ```json fence", () => {
    expect(stripCodeFence("```json\n[]\n```")).toBe("[]");
  });

  it("removes plain ``` fence", () => {
    expect(stripCodeFence("```\n[]\n```")).toBe("[]");
  });

  it("returns plain text unchanged", () => {
    expect(stripCodeFence("[]")).toBe("[]");
  });
});

describe("parseDecisions", () => {
  const DECISIONS = [{ number: 1, decision: "ready", reason: "clear spec" }];

  it("parses a bare JSON array", () => {
    expect(parseDecisions(JSON.stringify(DECISIONS))).toEqual(DECISIONS);
  });

  it("extracts JSON array when model emits conversational preamble", () => {
    const text = `I'll check each issue.\n${JSON.stringify(DECISIONS)}`;
    expect(parseDecisions(text)).toEqual(DECISIONS);
  });

  it("extracts JSON array when model emits preamble and postamble", () => {
    const text = `Sure! Here you go:\n${JSON.stringify(DECISIONS)}\nLet me know if you need more.`;
    expect(parseDecisions(text)).toEqual(DECISIONS);
  });

  it("strips code fence then extracts JSON array with preamble", () => {
    const text = `I'll evaluate now.\n\`\`\`json\n${JSON.stringify(DECISIONS)}\n\`\`\``;
    expect(parseDecisions(text)).toEqual(DECISIONS);
  });

  it("throws when input contains no JSON array", () => {
    expect(() => parseDecisions("I'll check each issue.")).toThrow(SyntaxError);
  });

  it("throws a meaningful error when result is not an array", () => {
    expect(() => parseDecisions(JSON.stringify({ not: "an array" }))).toThrow(
      "eval: expected JSON array of IssueDecision",
    );
  });

  it("throws when decision.number is not a number", () => {
    expect(() =>
      parseDecisions(
        JSON.stringify([{ number: "1", decision: "ready", reason: "x" }]),
      ),
    ).toThrow("eval: decision.number must be a number");
  });
});
