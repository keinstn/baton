import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner, shellQuote } from "../src/agent/claude-code.js";
import type { AgentEvent } from "../src/agent/runner.js";
import { makeConfig, toBashPath } from "./helpers.js";

async function fakeClaude(
  script: string,
): Promise<{ command: string; workspace: string }> {
  const dir = await mkdtemp(join(tmpdir(), "baton-cc-"));
  const commandFs = join(dir, "fake-claude");
  await writeFile(
    commandFs,
    `#!/usr/bin/env bash\ncat >/dev/null\n${script}\n`,
  );
  await chmod(commandFs, 0o755);
  const workspace = join(dir, "ws");
  await (await import("node:fs/promises")).mkdir(workspace);
  return { command: toBashPath(commandFs), workspace };
}

function runner(command: string, overrides: Record<string, unknown> = {}) {
  const config = makeConfig({ claude_code: { command, ...overrides } });
  return new ClaudeCodeRunner(config.claudeCode);
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

  it("adds --resume only when a session id is supplied (SPEC §10.1)", () => {
    const r = runner("claude");
    expect(r.buildCommand("sess-9")).toContain("--resume 'sess-9'");
    expect(r.buildCommand(null)).not.toContain("--resume");
    expect(r.buildCommand()).not.toContain("--resume");
  });
});

describe("applyConfig (SPEC §6.2 hot-reload)", () => {
  it("updates buildCommand output on the next call", () => {
    const r = runner("claude", { permission_mode: "acceptEdits" });
    expect(r.buildCommand()).toContain("--permission-mode 'acceptEdits'");

    const updatedConfig = makeConfig({
      claude_code: {
        command: "claude",
        permission_mode: "bypassPermissions",
        model: "claude-haiku-4-5",
      },
    });
    r.applyConfig(updatedConfig.claudeCode);

    const cmd = r.buildCommand();
    expect(cmd).toContain("--permission-mode 'bypassPermissions'");
    expect(cmd).toContain("--model 'claude-haiku-4-5'");
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
    const completed = events.find((e) => e.event === "turn_completed");
    expect(completed?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
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

  it("emits best-effort usage from assistant messages when killed before result", async () => {
    const { command, workspace } = await fakeClaude(`
echo '{"type":"system","subtype":"init","session_id":"sess-kill"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}],"usage":{"input_tokens":100,"output_tokens":10}}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}],"usage":{"input_tokens":150,"output_tokens":20}}}'
`);
    const r = runner(command);
    const session = await r.startSession(workspace);
    const events: AgentEvent[] = [];
    await r.runTurn(session, "do the thing", (e) => events.push(e));

    const usageEvents = events.filter((e) => e.usage !== undefined);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.event).toBe("turn_cancelled");
    // input = latest (150), output = sum (10 + 20 = 30)
    expect(usageEvents[0]?.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
    });
  });

  it("does not double-count usage when result line is present", async () => {
    const { command, workspace } = await fakeClaude(`
echo '{"type":"system","subtype":"init","session_id":"sess-dc"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}],"usage":{"input_tokens":100,"output_tokens":10}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":200,"output_tokens":15}}'
`);
    const r = runner(command);
    const session = await r.startSession(workspace);
    const events: AgentEvent[] = [];
    const result = await r.runTurn(session, "do the thing", (e) =>
      events.push(e),
    );

    expect(result.ok).toBe(true);
    // Only turn_completed carries usage; no extra turn_cancelled from accumulator
    const usageEvents = events.filter((e) => e.usage !== undefined);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.event).toBe("turn_completed");
    expect(usageEvents[0]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 15,
    });
  });

  it("resumes the session on continuation turns and emits session_started once (SPEC §10.1, §17.5)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baton-cc-"));
    const argsLogFs = join(dir, "args.log");
    const commandFs = join(dir, "fake-claude");
    const argsLog = toBashPath(argsLogFs);
    const command = toBashPath(commandFs);
    await writeFile(
      commandFs,
      `#!/usr/bin/env bash\ncat >/dev/null\necho "$@" >> "${argsLog}"\n` +
        `echo '{"type":"system","subtype":"init","session_id":"sess-xyz"}'\n` +
        `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`,
    );
    await chmod(commandFs, 0o755);
    const workspace = join(dir, "ws");
    await mkdir(workspace);

    const r = runner(command);
    const session = await r.startSession(workspace);
    const first: AgentEvent[] = [];
    await r.runTurn(session, "first turn", (e) => first.push(e));
    const second: AgentEvent[] = [];
    await r.runTurn(session, "second turn", (e) => second.push(e));

    const lines = (await readFile(argsLogFs, "utf8")).trim().split("\n");
    expect(lines[0]).not.toContain("--resume");
    expect(lines[1]).toContain("--resume sess-xyz");

    // session_started fires only on the first turn, with the `-1` suffix.
    const started = first.find((e) => e.event === "session_started");
    expect(started?.payload?.session_id).toBe("sess-xyz-1");
    expect(second.find((e) => e.event === "session_started")).toBeUndefined();
    expect(session.turnNumber).toBe(2);
  });
});
