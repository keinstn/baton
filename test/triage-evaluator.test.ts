import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluatorConfig } from "../scripts/triage/config.js";
import { createEvaluator, renderPrompt } from "../scripts/triage/evaluator.js";
import type { TriageIssue } from "../scripts/triage/fetcher.js";

// Mock the subprocess module so no real CLIs are spawned
vi.mock("../scripts/lib/subprocess.js", () => ({
  runOnce: vi.fn(),
}));

import { runOnce } from "../scripts/lib/subprocess.js";

const mockRunOnce = vi.mocked(runOnce);

function makeIssue(overrides: Partial<TriageIssue> = {}): TriageIssue {
  return {
    id: "I_1",
    itemId: "PVTI_1",
    identifier: "repo-1",
    number: 1,
    repository: "acme/repo",
    title: "Test issue",
    description: "body",
    priority: null,
    state: "Todo",
    closed: false,
    url: "https://github.com/acme/repo/issues/1",
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: null,
    openSubIssues: [],
    hasSubIssues: false,
    subIssueLookupFailed: false,
    ...overrides,
  };
}

const BASE_DECISIONS = [{ number: 1, decision: "ready", reason: "clear spec" }];

const CLAUDE_CONFIG: EvaluatorConfig = {
  kind: "claude_code",
  command: "claude",
  model: null,
  timeoutMs: 30_000,
  permissionMode: "bypassPermissions",
};

const COPILOT_CONFIG: EvaluatorConfig = {
  kind: "copilot",
  command: "copilot",
  model: null,
  timeoutMs: 30_000,
  permissionMode: "bypassPermissions",
};

// A minimal LiquidJS-compatible template
const TEMPLATE = "issues: {{ issues | json }}";

beforeEach(() => {
  mockRunOnce.mockReset();
});

// ---------------------------------------------------------------------------
// createEvaluator factory
// ---------------------------------------------------------------------------

describe("createEvaluator", () => {
  it("returns an evaluator with an evaluate method for claude_code", () => {
    const ev = createEvaluator(CLAUDE_CONFIG);
    expect(typeof ev.evaluate).toBe("function");
  });

  it("returns an evaluator with an evaluate method for copilot", () => {
    const ev = createEvaluator(COPILOT_CONFIG);
    expect(typeof ev.evaluate).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// claude-eval adapter
// ---------------------------------------------------------------------------

describe("claude-eval adapter", () => {
  it("extracts result from stream-json output and parses IssueDecision[]", async () => {
    const resultText = JSON.stringify(BASE_DECISIONS);
    const stdout = [
      JSON.stringify({ type: "assistant", text: "thinking..." }),
      JSON.stringify({ type: "result", result: resultText }),
    ].join("\n");
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("strips ```json code fence from result before parsing", async () => {
    const resultText = `\`\`\`json\n${JSON.stringify(BASE_DECISIONS)}\n\`\`\``;
    const stdout = JSON.stringify({ type: "result", result: resultText });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("strips plain ``` code fence from result before parsing", async () => {
    const resultText = `\`\`\`\n${JSON.stringify(BASE_DECISIONS)}\n\`\`\``;
    const stdout = JSON.stringify({ type: "result", result: resultText });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("includes --model flag when model is configured", async () => {
    const stdout = JSON.stringify({
      type: "result",
      result: JSON.stringify(BASE_DECISIONS),
    });
    mockRunOnce.mockResolvedValue(stdout);

    const config: EvaluatorConfig = {
      ...CLAUDE_CONFIG,
      model: "claude-opus-4-8",
    };
    const ev = createEvaluator(config);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--model 'claude-opus-4-8'");
  });

  it("does not include --model flag when model is null", async () => {
    const stdout = JSON.stringify({
      type: "result",
      result: JSON.stringify(BASE_DECISIONS),
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).not.toContain("--model");
  });

  it("sends rendered prompt as stdin", async () => {
    const stdout = JSON.stringify({
      type: "result",
      result: JSON.stringify(BASE_DECISIONS),
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [, stdin] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(typeof stdin).toBe("string");
    expect(stdin?.length).toBeGreaterThan(0);
  });

  it("throws when no result line is present in stdout", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "assistant", text: "partial output" }),
    );

    const ev = createEvaluator(CLAUDE_CONFIG);
    await expect(
      ev.evaluate([makeIssue()], TEMPLATE, "acme/repo"),
    ).rejects.toThrow('{"type":"result"}');
  });

  it("throws when result is not a JSON array", async () => {
    const stdout = JSON.stringify({
      type: "result",
      result: JSON.stringify({ not: "an array" }),
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    await expect(
      ev.evaluate([makeIssue()], TEMPLATE, "acme/repo"),
    ).rejects.toThrow();
  });

  it("throws with error prose when is_error=true result line is present", async () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Rate limit exceeded",
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    await expect(
      ev.evaluate([makeIssue()], TEMPLATE, "acme/repo"),
    ).rejects.toThrow("claude returned an error: Rate limit exceeded");
  });

  it("throws on first is_error=true result line even when a non-error line follows", async () => {
    const resultText = JSON.stringify(BASE_DECISIONS);
    const stdout = [
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "partial error",
      }),
      JSON.stringify({ type: "result", result: resultText }),
    ].join("\n");
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(CLAUDE_CONFIG);
    await expect(
      ev.evaluate([makeIssue()], TEMPLATE, "acme/repo"),
    ).rejects.toThrow("claude returned an error: partial error");
  });

  it("passes timeout from config to runOnce", async () => {
    const stdout = JSON.stringify({
      type: "result",
      result: JSON.stringify(BASE_DECISIONS),
    });
    mockRunOnce.mockResolvedValue(stdout);

    const config: EvaluatorConfig = { ...CLAUDE_CONFIG, timeoutMs: 12_345 };
    const ev = createEvaluator(config);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [, , opts] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(opts).toEqual({ timeoutMs: 12_345 });
  });
});

// ---------------------------------------------------------------------------
// copilot-eval adapter
// ---------------------------------------------------------------------------

describe("copilot-eval adapter", () => {
  it("concatenates assistant.message content and parses IssueDecision[]", async () => {
    const part1 = JSON.stringify(BASE_DECISIONS).slice(
      0,
      Math.floor(JSON.stringify(BASE_DECISIONS).length / 2),
    );
    const part2 = JSON.stringify(BASE_DECISIONS).slice(part1.length);
    const stdout = [
      JSON.stringify({ type: "assistant.message", data: { content: part1 } }),
      JSON.stringify({ type: "assistant.message", data: { content: part2 } }),
    ].join("\n");
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("handles a single assistant.message line", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("strips ```json code fence before parsing", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(BASE_DECISIONS)}\n\`\`\``;
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: fenced },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("strips plain ``` code fence before parsing", async () => {
    const fenced = `\`\`\`\n${JSON.stringify(BASE_DECISIONS)}\n\`\`\``;
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: fenced },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    const decisions = await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    expect(decisions).toEqual(BASE_DECISIONS);
  });

  it("includes --session-id flag in command", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--session-id");
  });

  it("does not use stdin (undefined)", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [, stdin] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(stdin).toBeUndefined();
  });

  it("includes --model flag when model is configured", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const config: EvaluatorConfig = { ...COPILOT_CONFIG, model: "gpt-4o" };
    const ev = createEvaluator(config);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--model 'gpt-4o'");
  });

  it("does not include --model flag when model is null", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).not.toContain("--model");
  });

  it("does not include --deny-tool when denyTools is not configured", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).not.toContain("--deny-tool");
  });

  it("includes --deny-tool flags when denyTools is configured", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const config: EvaluatorConfig = {
      ...COPILOT_CONFIG,
      denyTools: ["shell", "filesystem"],
    };
    const ev = createEvaluator(config);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--deny-tool='shell'");
    expect(command).toContain("--deny-tool='filesystem'");
  });

  it("throws when prompt exceeds 128 KiB", async () => {
    const ev = createEvaluator(COPILOT_CONFIG);
    const bigIssue = makeIssue({ description: "x".repeat(130 * 1024) });
    await expect(
      ev.evaluate([bigIssue], TEMPLATE, "acme/repo"),
    ).rejects.toThrow("prompt too large for argv");
  });

  it("throws when no assistant.message lines are present", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "tool.call", data: {} }),
    );

    const ev = createEvaluator(COPILOT_CONFIG);
    await expect(
      ev.evaluate([makeIssue()], TEMPLATE, "acme/repo"),
    ).rejects.toThrow("assistant.message");
  });

  it("throws when content is not a JSON array", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify({ not: "an array" }) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const ev = createEvaluator(COPILOT_CONFIG);
    await expect(
      ev.evaluate([makeIssue()], TEMPLATE, "acme/repo"),
    ).rejects.toThrow();
  });

  it("passes timeout from config to runOnce", async () => {
    const stdout = JSON.stringify({
      type: "assistant.message",
      data: { content: JSON.stringify(BASE_DECISIONS) },
    });
    mockRunOnce.mockResolvedValue(stdout);

    const config: EvaluatorConfig = { ...COPILOT_CONFIG, timeoutMs: 99_000 };
    const ev = createEvaluator(config);
    await ev.evaluate([makeIssue()], TEMPLATE, "acme/repo");

    const [, , opts] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(opts).toEqual({ timeoutMs: 99_000 });
  });
});

// ---------------------------------------------------------------------------
// renderPrompt — openSubIssues rendering
// ---------------------------------------------------------------------------

const SUB_ISSUE_TEMPLATE = `{% for issue in issues %}**Open sub-issues ({{ issue.openSubIssues.size }}):** {% if issue.openSubIssues.size > 0 %}{% for s in issue.openSubIssues %}#{{ s.number }} {{ s.title }}{% unless forloop.last %}, {% endunless %}{% endfor %}{% else %}none{% endif %}{% endfor %}`;

describe("renderPrompt — openSubIssues", () => {
  it("renders 'none' when openSubIssues is empty", async () => {
    const result = await renderPrompt(
      SUB_ISSUE_TEMPLATE,
      [makeIssue({ openSubIssues: [] })],
      "acme/repo",
    );
    expect(result).toBe("**Open sub-issues (0):** none");
  });

  it("renders sub-issue numbers and titles when openSubIssues is non-empty", async () => {
    const result = await renderPrompt(
      SUB_ISSUE_TEMPLATE,
      [
        makeIssue({
          openSubIssues: [
            {
              number: 10,
              title: "Sub A",
              url: "https://github.com/acme/repo/issues/10",
            },
            {
              number: 11,
              title: "Sub B",
              url: "https://github.com/acme/repo/issues/11",
            },
          ],
        }),
      ],
      "acme/repo",
    );
    expect(result).toBe("**Open sub-issues (2):** #10 Sub A, #11 Sub B");
  });

  it("renders a single sub-issue without a trailing comma", async () => {
    const result = await renderPrompt(
      SUB_ISSUE_TEMPLATE,
      [
        makeIssue({
          openSubIssues: [
            {
              number: 5,
              title: "Only one",
              url: "https://github.com/acme/repo/issues/5",
            },
          ],
        }),
      ],
      "acme/repo",
    );
    expect(result).toBe("**Open sub-issues (1):** #5 Only one");
  });
});
