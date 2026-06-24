import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeReviewRunner } from "../scripts/review/claude-run.js";
import type { ReviewConfig } from "../scripts/review/config.js";
import { createCopilotReviewRunner } from "../scripts/review/copilot-run.js";

vi.mock("../scripts/lib/subprocess.js", () => ({
  runOnce: vi.fn(),
}));

import { runOnce } from "../scripts/lib/subprocess.js";

const mockRunOnce = vi.mocked(runOnce);

function makeConfig(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    tracker: {
      token: "token",
      owner: "acme",
      ownerType: "organization",
      projectNumber: 1,
      statusField: "Status",
      activeStates: ["Todo"],
      repos: null,
    },
    workspace: {
      root: "/tmp/review",
      hookTimeoutMs: 120000,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
    },
    agent: {
      kind: "claude_code",
      timeoutMs: 30000,
      model: null,
      maxConcurrent: 1,
    },
    copilot: {
      allowAllTools: false,
      allowTools: [],
      denyTools: [],
    },
    claudeCode: {
      permissionMode: "bypassPermissions",
      denyTools: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockRunOnce.mockReset();
});

describe("createClaudeReviewRunner", () => {
  it("builds command with --verbose and optional flags, then validates result line", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "result", is_error: false, result: "ok" }),
    );
    const config = makeConfig({
      agent: {
        kind: "claude_code",
        timeoutMs: 12345,
        model: "claude-opus-4.7",
        maxConcurrent: 1,
      },
      claudeCode: {
        permissionMode: "acceptEdits",
        denyTools: ["Bash(rm:*)", "Edit"],
      },
    });

    await createClaudeReviewRunner(config).run("/tmp/ws", "review this");

    const [command, stdin, opts] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--verbose");
    expect(command).toContain("--permission-mode 'acceptEdits'");
    expect(command).toContain("--disallowedTools 'Bash(rm:*),Edit'");
    expect(command).toContain("--model 'claude-opus-4.7'");
    expect(stdin).toBe("review this");
    expect(opts).toEqual({ timeoutMs: 12345, cwd: "/tmp/ws" });
  });

  it("throws when stream-json output has no result line", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "assistant", text: "partial" }),
    );
    await expect(
      createClaudeReviewRunner(makeConfig()).run("/tmp/ws", "p"),
    ).rejects.toThrow('{"type":"result"}');
  });

  it("throws when result line marks is_error=true", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Permission denied",
      }),
    );
    await expect(
      createClaudeReviewRunner(makeConfig()).run("/tmp/ws", "p"),
    ).rejects.toThrow("claude returned an error: Permission denied");
  });
});

describe("createCopilotReviewRunner", () => {
  it("uses --allow-all-tools for allowAllTools mode", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "result", exitCode: 0 }),
    );
    const config = makeConfig({
      agent: {
        kind: "copilot",
        timeoutMs: 22222,
        model: "gpt-5",
        maxConcurrent: 1,
      },
      copilot: { allowAllTools: true, allowTools: [], denyTools: [] },
    });

    await createCopilotReviewRunner(config).run("/tmp/ws", "run review");

    const [command, stdin, opts] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--allow-all-tools");
    expect(command).not.toContain("--allow-tool=*");
    expect(command).toContain("--model 'gpt-5'");
    expect(stdin).toBeUndefined();
    expect(opts).toEqual({ timeoutMs: 22222, cwd: "/tmp/ws" });
  });

  it("includes allow/deny tool flags when configured", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "result", exitCode: 0 }),
    );
    const config = makeConfig({
      agent: {
        kind: "copilot",
        timeoutMs: 30000,
        model: null,
        maxConcurrent: 1,
      },
      copilot: {
        allowAllTools: false,
        allowTools: ["Bash", "Read"],
        denyTools: ["shell(git:*)", "Edit"],
      },
    });

    await createCopilotReviewRunner(config).run("/tmp/ws", "run review");

    const [command] = mockRunOnce.mock.calls.at(0) ?? [];
    expect(command).toContain("--allow-tool='Bash'");
    expect(command).toContain("--allow-tool='Read'");
    expect(command).toContain("--deny-tool='shell(git:*)'");
    expect(command).toContain("--deny-tool='Edit'");
  });

  it("throws when prompt exceeds argv limit", async () => {
    const oversizedPrompt = "a".repeat(128 * 1024 + 1);
    await expect(
      createCopilotReviewRunner(
        makeConfig({
          agent: {
            kind: "copilot",
            timeoutMs: 30000,
            model: null,
            maxConcurrent: 1,
          },
        }),
      ).run("/tmp/ws", oversizedPrompt),
    ).rejects.toThrow("prompt too large");
    expect(mockRunOnce).not.toHaveBeenCalled();
  });

  it("throws when output has no result line", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
    );
    await expect(
      createCopilotReviewRunner(
        makeConfig({
          agent: {
            kind: "copilot",
            timeoutMs: 30000,
            model: null,
            maxConcurrent: 1,
          },
        }),
      ).run("/tmp/ws", "p"),
    ).rejects.toThrow('{"type":"result"}');
  });

  it("throws when copilot result exitCode is non-zero", async () => {
    mockRunOnce.mockResolvedValue(
      JSON.stringify({ type: "result", exitCode: 1 }),
    );
    await expect(
      createCopilotReviewRunner(
        makeConfig({
          agent: {
            kind: "copilot",
            timeoutMs: 30000,
            model: null,
            maxConcurrent: 1,
          },
        }),
      ).run("/tmp/ws", "p"),
    ).rejects.toThrow("non-zero exitCode: 1");
  });
});
