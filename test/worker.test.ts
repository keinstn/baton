import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/orchestrator/worker.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import type {
  AgentEvent,
  AgentEventCallback,
  AgentRunner,
  AgentSession,
  TurnResult,
} from "../src/agent/runner.js";
import { makeConfig, makeIssue, silentLogger } from "./helpers.js";

class FakeRunner implements AgentRunner {
  calls: string[] = [];
  lastPrompt = "";
  constructor(private readonly ok: boolean = true) {}

  async startSession(workspace: string): Promise<AgentSession> {
    this.calls.push("start");
    return { workspace, agentSessionId: "sess-1", proc: null };
  }

  async runTurn(
    _session: AgentSession,
    prompt: string,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult> {
    this.calls.push("turn");
    this.lastPrompt = prompt;
    onEvent({ event: "session_started", timestamp: "t", payload: { session_id: "sess-1" } });
    return this.ok ? { ok: true } : { ok: false, error: "boom" };
  }

  async stopSession(): Promise<void> {
    this.calls.push("stop");
  }
}

async function setup(opts: { runnerOk?: boolean; hooks?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "baton-worker-"));
  const config = makeConfig({ workspace: { root }, hooks: opts.hooks ?? {} });
  const workspaces = new WorkspaceManager(config, silentLogger);
  const runner = new FakeRunner(opts.runnerOk ?? true);
  const runWorker = createWorker({
    workspaces,
    runner,
    promptTemplate: () => "Work on {{ issue.identifier }}: {{ issue.title }}",
    logger: silentLogger,
  });
  return { root, runner, runWorker };
}

describe("worker attempt (SPEC §16.5, Phase 1 single turn)", () => {
  it("prepares the workspace, renders the prompt, and runs one agent turn", async () => {
    const { root, runner, runWorker } = await setup();
    const issue = makeIssue();
    const events: AgentEvent[] = [];
    await runWorker(issue, null, (e) => events.push(e));

    expect((await stat(join(root, "repo-1"))).isDirectory()).toBe(true);
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
    expect(runner.lastPrompt).toBe("Work on repo-1: Test issue");
    expect(events.map((e) => e.event)).toContain("session_started");
  });

  it("fails the attempt when the turn fails, still stopping the session and running after_run", async () => {
    const { runner, runWorker } = await setup({
      runnerOk: false,
      hooks: { after_run: "touch after_run_ran" },
    });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "turn_failed",
    });
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
  });

  it("aborts before starting the agent when before_run fails (SPEC §9.4)", async () => {
    const { runner, runWorker } = await setup({ hooks: { before_run: "exit 1" } });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "hook_failed",
    });
    expect(runner.calls).toEqual([]);
  });

  it("fails the attempt on a template error without starting the agent (SPEC §12.4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "baton-worker-"));
    const config = makeConfig({ workspace: { root } });
    const workspaces = new WorkspaceManager(config, silentLogger);
    const runner = new FakeRunner();
    const runWorker = createWorker({
      workspaces,
      runner,
      promptTemplate: () => "{{ undefined_variable }}",
      logger: silentLogger,
    });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "template_render_error",
    });
    expect(runner.calls).toEqual([]);
  });
});
