import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CopilotRunner,
  computeWindowsArgvPromptMaxBytes,
} from "../src/agent/copilot.js";
import { escapeWindowsCmdArg } from "../src/agent/process.js";
import type { AgentEvent } from "../src/agent/runner.js";
import { makeConfig } from "./helpers.js";

const isWindows = process.platform === "win32";

async function fakeCopilot(
  script: string,
): Promise<{ command: string[]; workspace: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "baton-cp-"));
  const scriptPath = join(dir, "fake-copilot");
  await writeFile(scriptPath, `#!/usr/bin/env bash\n${script}\n`);
  await chmod(scriptPath, 0o755);
  const workspace = join(dir, "ws");
  await mkdir(workspace);
  return { command: [scriptPath], workspace, dir };
}

function runner(
  command: string | string[],
  overrides: Record<string, unknown> = {},
) {
  const config = makeConfig({
    agent: { kind: "copilot" },
    copilot: { command, ...overrides },
  });
  return new CopilotRunner(config.copilot);
}

const SUCCESS_SCRIPT = `
echo '{"type":"session.mcp_servers_loaded","data":{},"ephemeral":true}'
echo '{"type":"assistant.turn_start","data":{"turnId":"0"}}'
echo '{"type":"tool.execution_start","data":{"toolName":"view"}}'
echo '{"type":"tool.execution_complete","data":{"toolName":"view","success":true}}'
echo '{"type":"assistant.message","data":{"content":"hello world"}}'
echo 'this is not json'
echo '{"type":"result","exitCode":0,"sessionId":"abc","usage":{"premiumRequests":1.0}}'
`;

describe("Windows command helpers", () => {
  it("escapes percent signs before routing argv through cmd.exe shims", () => {
    expect(escapeWindowsCmdArg("show %PATH% and 100% done")).toBe(
      "show %%PATH%% and 100%% done",
    );
  });

  it("uses a much smaller argv prompt budget for Windows command lines", () => {
    const baseArgv = [
      "copilot",
      "-p",
      "",
      "--output-format",
      "json",
      "--no-ask-user",
      "--log-level",
      "none",
      "--session-id",
      "123e4567-e89b-12d3-a456-426614174000",
    ];
    const limit = computeWindowsArgvPromptMaxBytes(baseArgv);
    expect(limit).toBeLessThan(16 * 1024);
    expect(limit).toBeGreaterThan(1024);
  });
});

describe("CopilotRunner.buildCommand (SPEC §10.2)", () => {
  describe("string[] command (argv/direct-spawn path)", () => {
    it("includes JSONL output, no-ask-user, and pinned session id on first turn", () => {
      const r = runner(["copilot"]);
      const cmd = r.buildCommand("hello", "uuid-1", false);
      expect(Array.isArray(cmd)).toBe(true);
      const joined = (cmd as string[]).join(" ");
      expect(joined).toContain("-p hello");
      expect(joined).toContain("--output-format json");
      expect(joined).toContain("--no-ask-user");
      expect(joined).toContain("--session-id uuid-1");
      expect(joined).not.toContain("--resume");
    });

    it("uses --resume on continuation turns instead of --session-id", () => {
      const r = runner(["copilot"]);
      const cmd = (r.buildCommand("p", "uuid-2", true) as string[]).join(" ");
      expect(cmd).toContain("--resume uuid-2");
      expect(cmd).not.toContain("--session-id");
    });

    it("maps allow_all_tools / allow_tools / deny_tools / model / extra_args", () => {
      const r = runner(["copilot"], {
        allow_all_tools: true,
        allow_tools: ["shell(gh)", "view"],
        deny_tools: ["write"],
        model: "claude-opus-4-7",
        extra_args: ["--no-color"],
      });
      const cmd = (r.buildCommand("p", "u", false) as string[]).join(" ");
      expect(cmd).toContain("--allow-all-tools");
      expect(cmd).toContain("--allow-tool=shell(gh)");
      expect(cmd).toContain("--allow-tool=view");
      expect(cmd).toContain("--deny-tool=write");
      expect(cmd).toContain("--model claude-opus-4-7");
      expect(cmd).toContain("--no-color");
    });

    it("passes extra_args as literal argv elements (no shell quoting)", () => {
      const r = runner(["copilot"], {
        extra_args: ["--flag=hello world", "--other; rm -rf /"],
      });
      const cmd = r.buildCommand("p", "u", false) as string[];
      expect(cmd).toContain("--flag=hello world");
      expect(cmd).toContain("--other; rm -rf /");
    });

    it("passes prompts with special characters as literal argv (no quoting)", () => {
      const r = runner(["copilot"]);
      const cmd = r.buildCommand("o'clock", "u", false) as string[];
      expect(cmd).toContain("o'clock");
    });
  });

  describe("string command (shell/bash -lc path)", () => {
    it("returns a string with shell-quoted prompt and session id", () => {
      const r = runner("copilot");
      const cmd = r.buildCommand("o'clock", "uuid-1", false);
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("-p 'o'\\''clock'");
      expect(cmd).toContain("--session-id 'uuid-1'");
      expect(cmd).not.toContain("--resume");
    });

    it("shell-quotes --resume on continuation turns", () => {
      const r = runner("copilot");
      const cmd = r.buildCommand("p", "uuid-2", true);
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("--resume 'uuid-2'");
      expect(cmd).not.toContain("--session-id");
    });
  });
});

describe("CopilotRunner.applyConfig (SPEC §6.2 hot-reload)", () => {
  it("updates buildCommand output on the next call", () => {
    const r = runner(["copilot"], { allow_all_tools: false });
    expect(
      (r.buildCommand("p", "u", false) as string[]).join(" "),
    ).not.toContain("--allow-all-tools");
    const next = makeConfig({
      agent: { kind: "copilot" },
      copilot: { command: ["copilot"], allow_all_tools: true, model: "gpt-x" },
    });
    r.applyConfig(next.copilot);
    const cmd = (r.buildCommand("p", "u", false) as string[]).join(" ");
    expect(cmd).toContain("--allow-all-tools");
    expect(cmd).toContain("--model gpt-x");
  });
});

describe("CopilotRunner.startSession (SPEC §9.5 Invariant 1)", () => {
  it("rejects a non-directory workspace cwd", async () => {
    const r = runner(["copilot"]);
    await expect(
      r.startSession("/nonexistent/workspace"),
    ).rejects.toMatchObject({ code: "invalid_workspace_cwd" });
  });
});

describe.skipIf(isWindows)(
  "CopilotRunner.runTurn JSONL parsing (SPEC §10.2)",
  () => {
    it("parses a successful turn: session_started, events, zero usage", async () => {
      const { command, workspace } = await fakeCopilot(SUCCESS_SCRIPT);
      const r = runner(command);
      const session = await r.startSession(workspace);
      const events: AgentEvent[] = [];
      const result = await r.runTurn(session, "do the thing", (e) =>
        events.push(e),
      );

      expect(result.ok).toBe(true);
      expect(session.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);

      const kinds = events.map((e) => e.event);
      expect(kinds).toContain("session_started");
      expect(kinds).toContain("tool_use");
      expect(kinds).toContain("notification");
      expect(kinds).toContain("malformed");
      expect(kinds).toContain("turn_completed");

      // SPEC §10.2: token counts are zero (CLI does not expose them).
      const completed = events.find((e) => e.event === "turn_completed");
      expect(completed?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

      // session_started carries the composite id `<uuid>-1`.
      const started = events.find((e) => e.event === "session_started");
      expect(started?.payload?.session_id).toBe(`${session.agentSessionId}-1`);
    });

    it("maps a non-zero exitCode in result to a failed turn", async () => {
      const { command, workspace } = await fakeCopilot(
        `echo '{"type":"result","exitCode":2,"sessionId":"x"}'`,
      );
      const r = runner(command);
      const session = await r.startSession(workspace);
      const events: AgentEvent[] = [];
      const result = await r.runTurn(session, "x", (e) => events.push(e));
      expect(result.ok).toBe(false);
      expect(result.error).toContain("exit_code=2");
      expect(events.map((e) => e.event)).toContain("turn_failed");
    });

    it("maps a nonzero process exit without a result line to process_exit", async () => {
      const { command, workspace } = await fakeCopilot("exit 5");
      const r = runner(command);
      const session = await r.startSession(workspace);
      const result = await r.runTurn(session, "x", () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("process_exit code=5");
    });

    it("enforces the turn timeout (SPEC §10.3)", async () => {
      const { command, workspace } = await fakeCopilot("sleep 30");
      const r = runner(command, { turn_timeout_ms: 300 });
      const session = await r.startSession(workspace);
      const start = Date.now();
      const result = await r.runTurn(session, "x", () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe("turn_timeout");
      expect(Date.now() - start).toBeLessThan(5000);
    });

    it("rejects oversized prompts before launching the CLI (argv guard)", async () => {
      const { command, workspace } = await fakeCopilot("exit 0");
      const r = runner(command);
      const session = await r.startSession(workspace);
      const huge = "a".repeat(200 * 1024);
      const events: AgentEvent[] = [];
      const result = await r.runTurn(session, huge, (e) => events.push(e));
      expect(result.ok).toBe(false);
      expect(result.error).toContain("prompt_too_long");
      expect(events.map((e) => e.event)).toContain("turn_failed");
    });

    it("resumes the same session id on continuation turns (SPEC §10.1, §17.5)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "baton-cp-"));
      const argsLog = join(dir, "args.log");
      const scriptPath = join(dir, "fake-copilot");
      await writeFile(
        scriptPath,
        `#!/usr/bin/env bash\necho "$@" >> ${argsLog}\n` +
          `echo '{"type":"result","exitCode":0,"sessionId":"x"}'\n`,
      );
      await chmod(scriptPath, 0o755);
      const workspace = join(dir, "ws");
      await mkdir(workspace);

      const r = runner([scriptPath]);
      const session = await r.startSession(workspace);
      const first: AgentEvent[] = [];
      await r.runTurn(session, "first", (e) => first.push(e));
      const uuid = session.agentSessionId;
      expect(uuid).not.toBeNull();
      const second: AgentEvent[] = [];
      await r.runTurn(session, "second", (e) => second.push(e));

      const lines = (await readFile(argsLog, "utf8")).trim().split("\n");
      expect(lines[0]).toContain(`--session-id ${uuid}`);
      expect(lines[0]).not.toContain("--resume");
      expect(lines[1]).toContain(`--resume ${uuid}`);
      expect(lines[1]).not.toContain("--session-id");

      // session_started fires only on the first turn.
      expect(first.find((e) => e.event === "session_started")).toBeDefined();
      expect(second.find((e) => e.event === "session_started")).toBeUndefined();
      expect(session.turnNumber).toBe(2);
    });

    it("falls back to a fresh session when --resume fails on a continuation turn (SPEC §10.2)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "baton-cp-"));
      const argsLog = join(dir, "args.log");
      const scriptPath = join(dir, "fake-copilot");
      // Fail (exit 1) when --resume is present, succeed otherwise. Logs argv on
      // every invocation so the test can verify the retry uses --session-id.
      await writeFile(
        scriptPath,
        `#!/usr/bin/env bash
echo "$@" >> ${argsLog}
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then
    echo '{"type":"result","exitCode":1,"sessionId":"x"}'
    exit 0
  fi
done
echo '{"type":"result","exitCode":0,"sessionId":"x"}'
exit 0
`,
      );
      await chmod(scriptPath, 0o755);
      const workspace = join(dir, "ws");
      await mkdir(workspace);

      const r = runner([scriptPath]);
      const session = await r.startSession(workspace);
      await r.runTurn(session, "first", () => {});
      const firstUuid = session.agentSessionId;
      expect(firstUuid).not.toBeNull();
      const events: AgentEvent[] = [];
      const result = await r.runTurn(session, "second", (e) => events.push(e));

      expect(result.ok).toBe(true);
      expect(session.agentSessionId).not.toBe(firstUuid);

      const lines = (await readFile(argsLog, "utf8")).trim().split("\n");
      // 1: first turn (--session-id <firstUuid>)
      // 2: second turn attempt 1 (--resume <firstUuid>) → fails
      // 3: second turn retry (--session-id <newUuid>) → succeeds
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain(`--resume ${firstUuid}`);
      expect(lines[2]).toContain(`--session-id ${session.agentSessionId}`);
      expect(lines[2]).not.toContain(`--resume`);

      expect(events.map((e) => e.event)).toContain("notification");

      // SPEC §10.2: fresh-session fallback MUST emit session_started for the
      // new agent session so the orchestrator can update its session log.
      const started = events.find((e) => e.event === "session_started");
      expect(started).toBeDefined();
      expect(started?.payload?.session_id).toBe(
        `${session.agentSessionId}-${session.turnNumber}`,
      );
    });
  },
);
