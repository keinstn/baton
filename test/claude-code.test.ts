import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner, shellQuote } from "../src/agent/claude-code.js";
import type { AgentEvent } from "../src/agent/runner.js";
import { makeConfig, silentLogger } from "./helpers.js";

async function fakeClaude(
  script: string,
): Promise<{ command: string; workspace: string }> {
  const dir = await mkdtemp(join(tmpdir(), "baton-cc-"));
  const command = join(dir, "fake-claude");
  await writeFile(command, `#!/usr/bin/env bash\ncat >/dev/null\n${script}\n`);
  await chmod(command, 0o755);
  const workspace = join(dir, "ws");
  await (await import("node:fs/promises")).mkdir(workspace);
  return { command, workspace };
}

function runner(command: string, overrides: Record<string, unknown> = {}) {
  const config = makeConfig({ claude_code: { command, ...overrides } });
  return new ClaudeCodeRunner(config.claudeCode, silentLogger);
}

const SUCCESS_SCRIPT = `
echo '{"type":"system","subtype":"init","session_id":"sess-123"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"},{"type":"tool_use","name":"Bash"}]}}'
echo 'this is not json'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":10,"output_tokens":5}}'
`;

describe("shellQuote", () => {
  it("quotes shell metacharacters safely", () => {
    expect(shellQuote("simple")).toBe("'simple'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("buildCommand (SPEC §10.1)", () => {
  it("includes stream-json output and the documented permission posture", () => {
    const r = runner("claude", {
      permission_mode: "acceptEdits",
      allowed_tools: ["Bash(gh:*)", "Edit"],
      disallowed_tools: ["WebSearch"],
      model: "claude-opus-4-8",
    });
    const cmd = r.buildCommand();
    expect(cmd).toContain("-p --output-format stream-json --verbose");
    expect(cmd).toContain("--permission-mode 'acceptEdits'");
    expect(cmd).toContain("--allowedTools 'Bash(gh:*),Edit'");
    expect(cmd).toContain("--disallowedTools 'WebSearch'");
    expect(cmd).toContain("--model 'claude-opus-4-8'");
  });
});

describe("startSession (SPEC §9.5 Invariant 1)", () => {
  it("rejects a non-directory workspace cwd", async () => {
    const r = runner("claude");
    await expect(
      r.startSession("/nonexistent/workspace"),
    ).rejects.toMatchObject({
      code: "invalid_workspace_cwd",
    });
  });
});

describe("runTurn stream-json parsing (SPEC §10.1)", () => {
  it("parses a successful turn: session id, events, usage", async () => {
    const { command, workspace } = await fakeClaude(SUCCESS_SCRIPT);
    const r = runner(command);
    const session = await r.startSession(workspace);
    const events: AgentEvent[] = [];
    const result = await r.runTurn(session, "do the thing", (e) =>
      events.push(e),
    );

    expect(result.ok).toBe(true);
    expect(session.agentSessionId).toBe("sess-123");
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("session_started");
    expect(kinds).toContain("notification");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("malformed");
    expect(kinds).toContain("turn_completed");
    const completed = events.find((e) => e.event === "turn_completed")!;
    expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("maps an error result to a failed turn", async () => {
    const { command, workspace } = await fakeClaude(
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"failed badly"}'`,
    );
    const r = runner(command);
    const session = await r.startSession(workspace);
    const events: AgentEvent[] = [];
    const result = await r.runTurn(session, "x", (e) => events.push(e));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed badly");
    expect(events.map((e) => e.event)).toContain("turn_failed");
  });

  it("maps a nonzero exit without a result line to process_exit", async () => {
    const { command, workspace } = await fakeClaude("exit 3");
    const r = runner(command);
    const session = await r.startSession(workspace);
    const result = await r.runTurn(session, "x", () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("process_exit code=3");
  });

  it("enforces the turn timeout (SPEC §10.3)", async () => {
    const { command, workspace } = await fakeClaude("sleep 30");
    const r = runner(command, { turn_timeout_ms: 300 });
    const session = await r.startSession(workspace);
    const start = Date.now();
    const result = await r.runTurn(session, "x", () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("turn_timeout");
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
