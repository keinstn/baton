import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner } from "../src/agent/claude-code.js";
import type { AgentEvent } from "../src/agent/runner.js";
import { makeConfig } from "./helpers.js";

const isWindows = process.platform === "win32";

/** Creates a bash-script fake claude and returns { command: string[], workspace }. */
async function fakeClaude(
  script: string,
): Promise<{ command: string[]; workspace: string }> {
  const dir = await mkdtemp(join(tmpdir(), "baton-cc-"));
  const scriptPath = join(dir, "fake-claude");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash\ncat >/dev/null\n${script}\n`,
  );
  await chmod(scriptPath, 0o755);
  const workspace = join(dir, "ws");
  await mkdir(workspace);
  return { command: [scriptPath], workspace };
}

function runner(
  command: string | string[],
  overrides: Record<string, unknown> = {},
) {
  const config = makeConfig({ claude_code: { command, ...overrides } });
  return new ClaudeCodeRunner(config.claudeCode);
}

const SUCCESS_SCRIPT = `
echo '{"type":"system","subtype":"init","session_id":"sess-123"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"},{"type":"tool_use","name":"Bash"}]}}'
echo 'this is not json'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":10,"output_tokens":5}}'
`;

describe("buildCommand (SPEC §10.1)", () => {
  it("includes stream-json output and the documented permission posture", () => {
    const r = runner("claude", {
      permission_mode: "acceptEdits",
      allowed_tools: ["Bash(gh:*)", "Edit"],
      disallowed_tools: ["WebSearch"],
      model: "claude-opus-4-8",
    });
    const cmd = r.buildCommand().join(" ");
    expect(cmd).toContain("-p --output-format stream-json --verbose");
    expect(cmd).toContain("--permission-mode acceptEdits");
    expect(cmd).toContain("--allowedTools Bash(gh:*),Edit");
    expect(cmd).toContain("--disallowedTools WebSearch");
    expect(cmd).toContain("--model claude-opus-4-8");
  });

  it("adds --resume only when a session id is supplied (SPEC §10.1)", () => {
    const r = runner("claude");
    expect(r.buildCommand("sess-9").join(" ")).toContain("--resume sess-9");
    expect(r.buildCommand(null).join(" ")).not.toContain("--resume");
    expect(r.buildCommand().join(" ")).not.toContain("--resume");
  });

  it("returns a string[] argv (no shell quoting)", () => {
    const r = runner("claude", { permission_mode: "acceptEdits" });
    const cmd = r.buildCommand();
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("acceptEdits");
    // Values must not be shell-quoted.
    expect(cmd.join(" ")).not.toContain("'acceptEdits'");
  });
});

describe("applyConfig (SPEC §6.2 hot-reload)", () => {
  it("updates buildCommand output on the next call", () => {
    const r = runner("claude", { permission_mode: "acceptEdits" });
    expect(r.buildCommand().join(" ")).toContain(
      "--permission-mode acceptEdits",
    );

    const updatedConfig = makeConfig({
      claude_code: {
        command: "claude",
        permission_mode: "bypassPermissions",
        model: "claude-haiku-4-5",
      },
    });
    r.applyConfig(updatedConfig.claudeCode);

    const cmd = r.buildCommand().join(" ");
    expect(cmd).toContain("--permission-mode bypassPermissions");
    expect(cmd).toContain("--model claude-haiku-4-5");
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

describe.skipIf(isWindows)("runTurn stream-json parsing (SPEC §10.1)", () => {
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

  it("resumes the session on continuation turns and emits session_started once (SPEC §10.1, §17.5)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baton-cc-"));
    const argsLog = join(dir, "args.log");
    const scriptPath = join(dir, "fake-claude");
    await writeFile(
      scriptPath,
      `#!/usr/bin/env bash\ncat >/dev/null\necho "$@" >> ${argsLog}\n` +
        `echo '{"type":"system","subtype":"init","session_id":"sess-xyz"}'\n` +
        `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`,
    );
    await chmod(scriptPath, 0o755);
    const workspace = join(dir, "ws");
    await mkdir(workspace);

    const r = runner([scriptPath]);
    const session = await r.startSession(workspace);
    const first: AgentEvent[] = [];
    await r.runTurn(session, "first turn", (e) => first.push(e));
    const second: AgentEvent[] = [];
    await r.runTurn(session, "second turn", (e) => second.push(e));

    const lines = (await readFile(argsLog, "utf8")).trim().split("\n");
    expect(lines[0]).not.toContain("--resume");
    expect(lines[1]).toContain("--resume sess-xyz");

    // session_started fires only on the first turn, with the `-1` suffix.
    const started = first.find((e) => e.event === "session_started");
    expect(started?.payload?.session_id).toBe("sess-xyz-1");
    expect(second.find((e) => e.event === "session_started")).toBeUndefined();
    expect(session.turnNumber).toBe(2);
  });
});
