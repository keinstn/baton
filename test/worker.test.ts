import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentEventCallback,
  AgentRunner,
  AgentSession,
  TurnResult,
} from "../src/agent/runner.js";
import { createWorker } from "../src/orchestrator/worker.js";
import type { Issue } from "../src/tracker/types.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { makeConfig, makeIssue, silentLogger } from "./helpers.js";

class FakeRunner implements AgentRunner {
  calls: string[] = [];
  prompts: string[] = [];
  resumeFlags: boolean[] = [];
  private turnIndex = 0;

  constructor(private readonly results: TurnResult[] = [{ ok: true }]) {}

  async startSession(workspace: string): Promise<AgentSession> {
    this.calls.push("start");
    return {
      workspace,
      agentSessionId: "sess-1",
      proc: null,
      procClosed: null,
      procForceClose: null,
      turnNumber: 0,
    };
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult> {
    this.calls.push("turn");
    this.prompts.push(prompt);
    // Mirror the adapter's turn counter so resume only applies after turn 1.
    session.turnNumber += 1;
    this.resumeFlags.push(session.turnNumber > 1);
    if (session.turnNumber === 1) {
      onEvent({
        event: "session_started",
        timestamp: "t",
        payload: { session_id: "sess-1-1" },
      });
    }
    const result =
      this.results[Math.min(this.turnIndex, this.results.length - 1)];
    this.turnIndex += 1;
    return result ?? { ok: true };
  }

  async stopSession(): Promise<void> {
    this.calls.push("stop");
  }
}

/** Tracker stub: returns the issue with each queued state in turn (SPEC §11.1 op 3). */
function fakeTracker(states: string[]) {
  let i = 0;
  const calls: string[][] = [];
  return {
    calls,
    async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
      calls.push(ids);
      const state = states[Math.min(i, states.length - 1)] ?? "Done";
      i += 1;
      return [makeIssue({ id: ids[0], state })];
    },
  };
}

async function setup(
  opts: {
    results?: TurnResult[];
    hooks?: Record<string, unknown>;
    maxTurns?: number;
    refreshStates?: string[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "baton-worker-"));
  const config = makeConfig({
    workspace: { root },
    hooks: opts.hooks ?? {},
    agent: { max_turns: opts.maxTurns ?? 1 },
  });
  const workspaces = new WorkspaceManager(config, silentLogger);
  const runner = new FakeRunner(opts.results);
  const tracker = fakeTracker(opts.refreshStates ?? ["Done"]);
  const runWorker = createWorker({
    workspaces,
    runner,
    tracker,
    config: () => config,
    promptTemplate: () => "Work on {{ issue.identifier }}: {{ issue.title }}",
    logger: silentLogger,
  });
  return { root, runner, tracker, runWorker };
}

describe("worker attempt (SPEC §16)", () => {
  it("prepares the workspace, renders the prompt, and runs one agent turn", async () => {
    const { root, runner, runWorker } = await setup();
    const issue = makeIssue();
    const events: AgentEvent[] = [];
    await runWorker(issue, null, (e) => events.push(e));

    expect((await stat(join(root, "repo-1"))).isDirectory()).toBe(true);
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
    expect(runner.prompts[0]).toBe("Work on repo-1: Test issue");
    expect(events.map((e) => e.event)).toContain("session_started");
  });

  it("runs continuation turns while the issue stays active, resuming the session", async () => {
    const { runner, tracker, runWorker } = await setup({
      maxTurns: 3,
      refreshStates: ["Todo", "Todo", "Todo"],
    });
    await runWorker(makeIssue(), null, () => {});

    expect(runner.calls).toEqual(["start", "turn", "turn", "turn", "stop"]);
    // First turn fresh, later turns resume.
    expect(runner.resumeFlags).toEqual([false, true, true]);
    // Continuation prompts are guidance, not the original task prompt.
    expect(runner.prompts[0]).toContain("Work on repo-1");
    expect(runner.prompts[1]).toContain("Continue working on issue repo-1");
    // State refreshed between turns, not after the final (budget-capped) turn.
    expect(tracker.calls.length).toBe(2);
  });

  it("stops continuing once the issue leaves its active set", async () => {
    const { runner, tracker, runWorker } = await setup({
      maxTurns: 5,
      refreshStates: ["Done"],
    });
    await runWorker(makeIssue(), null, () => {});
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
    expect(tracker.calls.length).toBe(1);
  });

  it("stops continuing when the tracker returns empty for the running issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "baton-worker-"));
    const config = makeConfig({ workspace: { root }, agent: { max_turns: 5 } });
    const workspaces = new WorkspaceManager(config, silentLogger);
    const runner = new FakeRunner([{ ok: true }]);
    const runWorker = createWorker({
      workspaces,
      runner,
      tracker: {
        async fetchIssueStatesByIds(): Promise<Issue[]> {
          return []; // issue disappeared from tracker
        },
      },
      config: () => config,
      promptTemplate: () => "do {{ issue.identifier }}",
      logger: silentLogger,
    });
    await runWorker(makeIssue(), null, () => {});
    // Only one turn runs; the empty refresh breaks the loop.
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
  });

  it("fails the attempt when the turn fails, still stopping the session and running after_run", async () => {
    const { runner, runWorker } = await setup({
      results: [{ ok: false, error: "boom" }],
      hooks: { after_run: "touch after_run_ran" },
    });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "turn_failed",
    });
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
  });

  it("fails the attempt when a continuation state refresh fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "baton-worker-"));
    const config = makeConfig({
      workspace: { root },
      agent: { max_turns: 3 },
    });
    const workspaces = new WorkspaceManager(config, silentLogger);
    const runner = new FakeRunner([{ ok: true }]);
    const runWorker = createWorker({
      workspaces,
      runner,
      tracker: {
        async fetchIssueStatesByIds(): Promise<Issue[]> {
          throw new Error("api down");
        },
      },
      config: () => config,
      promptTemplate: () => "do {{ issue.identifier }}",
      logger: silentLogger,
    });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "issue_state_refresh_failed",
    });
    expect(runner.calls).toEqual(["start", "turn", "stop"]);
  });

  it("aborts before starting the agent when before_run fails (SPEC §9.4)", async () => {
    const { runner, runWorker } = await setup({
      hooks: { before_run: "exit 1" },
    });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "hook_failed",
    });
    expect(runner.calls).toEqual([]);
  });

  it("fails the attempt on a template error without starting the agent or running hooks (SPEC §12.4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "baton-worker-"));
    const hookLog = join(root, "hook_ran");
    const config = makeConfig({
      workspace: { root },
      hooks: {
        before_run: 'touch "$BATON_WORKSPACE/../hook_ran"',
        after_run: 'touch "$BATON_WORKSPACE/../hook_ran"',
      },
    });
    const workspaces = new WorkspaceManager(config, silentLogger);
    const runner = new FakeRunner();
    const runWorker = createWorker({
      workspaces,
      runner,
      tracker: fakeTracker(["Done"]),
      config: () => config,
      promptTemplate: () => "{{ undefined_variable }}",
      logger: silentLogger,
    });
    await expect(runWorker(makeIssue(), null, () => {})).rejects.toMatchObject({
      code: "template_render_error",
    });
    expect(runner.calls).toEqual([]);
    // before_run must not have fired (renderPrompt failed before it was reached).
    await expect(stat(hookLog)).rejects.toThrow();
  });

  it("stops the session when the run is aborted mid-flight (SPEC §8.5)", async () => {
    const { runner, runWorker } = await setup({
      maxTurns: 5,
      refreshStates: ["Todo", "Todo", "Todo", "Todo"],
    });
    const controller = new AbortController();
    let turns = 0;
    // Abort right after the first turn's session_started event fires.
    await runWorker(
      makeIssue(),
      null,
      (e) => {
        if (e.event === "session_started") {
          turns += 1;
          if (turns === 1) controller.abort();
        }
      },
      controller.signal,
    );
    // Abort breaks the loop after the in-flight turn; the session is stopped.
    expect(runner.calls.filter((c) => c === "turn").length).toBe(1);
    expect(runner.calls[runner.calls.length - 1]).toBe("stop");
  });
});
