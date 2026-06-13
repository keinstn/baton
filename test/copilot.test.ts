import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CopilotRunner } from "../src/agent/copilot.js";
import type { AgentEvent } from "../src/agent/runner.js";
import {
  makeConfig,
  makeMockAgent,
  mockAgentDir,
  writeMockAgent,
} from "./helpers.js";

function runner(command: string, overrides: Record<string, unknown> = {}) {
  const config = makeConfig({
    agent: { kind: "copilot" },
    copilot: { command, ...overrides },
  });
  return new CopilotRunner(config.copilot);
}

// Fake `copilot` CLI: emits JSONL lines then exits with a result line.
const SUCCESS_BODY = [
  `process.stdout.write('{"type":"session.mcp_servers_loaded","data":{},"ephemeral":true}\\n');`,
  `process.stdout.write('{"type":"assistant.turn_start","data":{"turnId":"0"}}\\n');`,
  `process.stdout.write('{"type":"tool.execution_start","data":{"toolName":"view"}}\\n');`,
  `process.stdout.write('{"type":"tool.execution_complete","data":{"toolName":"view","success":true}}\\n');`,
  `process.stdout.write('{"type":"assistant.message","data":{"content":"hello world"}}\\n');`,
  `process.stdout.write('this is not json\\n');`,
  `process.stdout.write('{"type":"result","exitCode":0,"sessionId":"abc","usage":{"premiumRequests":1.0}}\\n');`,
].join("\n");

describe("CopilotRunner.buildCommand (SPEC §10.2)", () => {
  it("includes JSONL output, no-ask-user, and pinned session id on first turn", () => {
    const r = runner("copilot");
    const cmd = r.buildCommand("hello", "uuid-1", false).join(" ");
    expect(cmd).toContain("-p hello");
    expect(cmd).toContain("--output-format json");
    expect(cmd).toContain("--no-ask-user");
    expect(cmd).toContain("--session-id uuid-1");
    expect(cmd).not.toContain("--resume");
  });

  it("uses --resume on continuation turns instead of --session-id", () => {
    const r = runner("copilot");
    const cmd = r.buildCommand("p", "uuid-2", true).join(" ");
    expect(cmd).toContain("--resume uuid-2");
    expect(cmd).not.toContain("--session-id");
  });

  it("maps allow_all_tools / allow_tools / deny_tools / model / extra_args", () => {
    const r = runner("copilot", {
      allow_all_tools: true,
      allow_tools: ["shell(gh)", "view"],
      deny_tools: ["write"],
      model: "claude-opus-4-7",
      extra_args: ["--no-color"],
    });
    const cmd = r.buildCommand("p", "u", false);
    expect(cmd).toContain("--allow-all-tools");
    expect(cmd).toContain("--allow-tool=shell(gh)");
    expect(cmd).toContain("--allow-tool=view");
    expect(cmd).toContain("--deny-tool=write");
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-opus-4-7");
    expect(cmd).toContain("--no-color");
  });

  it("passes extra_args and prompts as discrete argv elements verbatim", () => {
    // With argv-based spawn there is no shell, so metacharacters need no
    // escaping: each value reaches the CLI as one untouched argument.
    const r = runner("copilot", {
      extra_args: ["--flag=hello world", "--other; rm -rf /"],
    });
    const cmd = r.buildCommand("o'clock", "u", false);
    expect(cmd).toContain("--flag=hello world");
    expect(cmd).toContain("--other; rm -rf /");
    const i = cmd.indexOf("-p");
    expect(cmd[i + 1]).toBe("o'clock");
  });
});

describe("CopilotRunner.applyConfig (SPEC §6.2 hot-reload)", () => {
  it("updates buildCommand output on the next call", () => {
    const r = runner("copilot", { allow_all_tools: false });
    expect(r.buildCommand("p", "u", false)).not.toContain("--allow-all-tools");
    const next = makeConfig({
      agent: { kind: "copilot" },
      copilot: { command: "copilot", allow_all_tools: true, model: "gpt-x" },
    });
    r.applyConfig(next.copilot);
    const cmd = r.buildCommand("p", "u", false).join(" ");
    expect(cmd).toContain("--allow-all-tools");
    expect(cmd).toContain("--model gpt-x");
  });
});

describe("CopilotRunner.startSession (SPEC §9.5 Invariant 1)", () => {
  it("rejects a non-directory workspace cwd", async () => {
    const r = runner("copilot");
    await expect(
      r.startSession("/nonexistent/workspace"),
    ).rejects.toMatchObject({ code: "invalid_workspace_cwd" });
  });
});

describe("CopilotRunner.runTurn JSONL parsing (SPEC §10.2)", () => {
  it("parses a successful turn: session_started, events, zero usage", async () => {
    const { command, workspace } = await makeMockAgent(
      SUCCESS_BODY,
      "baton-cp-",
    );
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
    const { command, workspace } = await makeMockAgent(
      `process.stdout.write('{"type":"result","exitCode":2,"sessionId":"x"}\\n');`,
      "baton-cp-",
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
    const { command, workspace } = await makeMockAgent(
      "process.exit(5);",
      "baton-cp-",
    );
    const r = runner(command);
    const session = await r.startSession(workspace);
    const result = await r.runTurn(session, "x", () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("process_exit code=5");
  });

  it("enforces the turn timeout (SPEC §10.3)", async () => {
    const { command, workspace } = await makeMockAgent(
      "setTimeout(() => {}, 30000);",
      "baton-cp-",
    );
    const r = runner(command, { turn_timeout_ms: 300 });
    const session = await r.startSession(workspace);
    const start = Date.now();
    const result = await r.runTurn(session, "x", () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("turn_timeout");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("rejects oversized prompts before launching the CLI (argv guard)", async () => {
    const { command, workspace } = await makeMockAgent(
      "process.exit(0);",
      "baton-cp-",
    );
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
    const { dir, workspace } = await mockAgentDir("baton-cp-");
    const argsLog = join(dir, "args.log");
    const command = await writeMockAgent(
      dir,
      [
        `require("fs").appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(" ") + "\\n");`,
        `process.stdout.write('{"type":"result","exitCode":0,"sessionId":"x"}\\n');`,
      ].join("\n"),
    );

    const r = runner(command);
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
    const { dir, workspace } = await mockAgentDir("baton-cp-");
    const argsLog = join(dir, "args.log");
    // Fail (exit 0 with error result) when --resume is present, succeed
    // otherwise. Logs argv on every invocation so the test can verify the
    // retry uses --session-id.
    const command = await writeMockAgent(
      dir,
      [
        `const args = process.argv.slice(2);`,
        `require("fs").appendFileSync(${JSON.stringify(argsLog)}, args.join(" ") + "\\n");`,
        `if (args.includes("--resume")) {`,
        `  process.stdout.write('{"type":"result","exitCode":1,"sessionId":"x"}\\n');`,
        `  process.exit(0);`,
        `}`,
        `process.stdout.write('{"type":"result","exitCode":0,"sessionId":"x"}\\n');`,
        `process.exit(0);`,
      ].join("\n"),
    );

    const r = runner(command);
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
});
