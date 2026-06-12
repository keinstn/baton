import { describe, expect, it, vi } from "vitest";
import {
  isDispatchEligible,
  Orchestrator,
  type OrchestratorDeps,
  type Scheduler,
  sortForDispatch,
} from "../src/orchestrator/orchestrator.js";
import type { Issue } from "../src/tracker/types.js";
import { makeConfig, makeIssue, silentLogger } from "./helpers.js";

const emptyState = { running: new Set<string>(), claimed: new Set<string>() };

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deterministic scheduler: timers fire only when the test calls fireAll/fireNext. */
function manualScheduler() {
  interface Task {
    fn: () => void;
    delayMs: number;
    cancelled: boolean;
  }
  const tasks: Task[] = [];
  const scheduler: Scheduler = (fn, delayMs) => {
    const task: Task = { fn, delayMs, cancelled: false };
    tasks.push(task);
    return {
      cancel() {
        task.cancelled = true;
      },
    };
  };
  return {
    scheduler,
    delays: () => tasks.filter((t) => !t.cancelled).map((t) => t.delayMs),
    pendingCount: () => tasks.filter((t) => !t.cancelled).length,
    /** Fire every task pending right now (snapshot), awaiting async handlers. */
    async fireAll(): Promise<void> {
      const snapshot = tasks.filter((t) => !t.cancelled);
      for (const t of snapshot) {
        t.cancelled = true;
        await t.fn();
      }
      await settle();
    },
  };
}

function makeOrchestrator(
  issues: Issue[] | (() => Promise<Issue[]>),
  overrides: Partial<OrchestratorDeps> = {},
) {
  const config = overrides.config?.() ?? makeConfig();
  const fetchCandidateIssues =
    typeof issues === "function" ? vi.fn(issues) : vi.fn(async () => issues);
  // For static lists, fetchIssueStatesByIds returns matching issues so retry
  // timers can re-dispatch without additional test setup. Dynamic callers that
  // need custom behaviour should supply tracker in overrides.
  const issueList = typeof issues === "function" ? null : issues;
  const fetchIssueStatesByIds = vi.fn(async (ids: string[]) =>
    (issueList ?? []).filter((i) => ids.includes(i.id)),
  );
  const clock = manualScheduler();
  const deps: OrchestratorDeps = {
    tracker: { fetchCandidateIssues, fetchIssueStatesByIds },
    runWorker: vi.fn(async () => {}),
    validate: () => ({ ok: true, errors: [] }),
    config: () => config,
    scheduler: clock.scheduler,
    logger: silentLogger,
    ...overrides,
  };
  return {
    orchestrator: new Orchestrator(deps),
    fetchCandidateIssues,
    fetchIssueStatesByIds,
    clock,
    runWorker: deps.runWorker as ReturnType<typeof vi.fn>,
  };
}

describe("sortForDispatch (SPEC §8.2)", () => {
  it("orders by priority, then created_at, then identifier", () => {
    const issues = [
      makeIssue({
        id: "a",
        identifier: "repo-3",
        priority: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makeIssue({
        id: "b",
        identifier: "repo-2",
        priority: 2,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makeIssue({
        id: "c",
        identifier: "repo-1",
        priority: 1,
        createdAt: "2026-01-02T00:00:00Z",
      }),
      makeIssue({
        id: "d",
        identifier: "repo-5",
        priority: 1,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makeIssue({
        id: "e",
        identifier: "repo-4",
        priority: 1,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ];
    expect(sortForDispatch(issues).map((i) => i.identifier)).toEqual([
      "repo-4",
      "repo-5",
      "repo-1",
      "repo-2",
      "repo-3",
    ]);
  });
});

describe("isDispatchEligible (SPEC §8.2)", () => {
  const config = makeConfig({ tracker: { required_labels: ["ai-ready"] } });

  it("requires active state, open issue, and all required labels", () => {
    expect(
      isDispatchEligible(
        makeIssue({ labels: ["ai-ready"] }),
        config,
        emptyState,
      ),
    ).toBe(true);
    expect(
      isDispatchEligible(makeIssue({ labels: [] }), config, emptyState),
    ).toBe(false);
    expect(
      isDispatchEligible(
        makeIssue({ labels: ["ai-ready"], state: "Done" }),
        config,
        emptyState,
      ),
    ).toBe(false);
    expect(
      isDispatchEligible(
        makeIssue({ labels: ["ai-ready"], state: "" }),
        config,
        emptyState,
      ),
    ).toBe(false);
    expect(
      isDispatchEligible(
        makeIssue({ labels: ["ai-ready"], closed: true }),
        config,
        emptyState,
      ),
    ).toBe(false);
  });

  it("compares states case-insensitively", () => {
    expect(
      isDispatchEligible(
        makeIssue({ labels: ["ai-ready"], state: "todo" }),
        config,
        emptyState,
      ),
    ).toBe(true);
  });

  it("a blank configured label matches no issue", () => {
    const blank = makeConfig({ tracker: { required_labels: [" "] } });
    expect(
      isDispatchEligible(makeIssue({ labels: ["x"] }), blank, emptyState),
    ).toBe(false);
  });

  it("applies the repos filter", () => {
    const repos = makeConfig({ tracker: { repos: ["acme/other"] } });
    expect(isDispatchEligible(makeIssue(), repos, emptyState)).toBe(false);
  });

  it("skips issues already running or claimed", () => {
    const issue = makeIssue({ labels: ["ai-ready"] });
    expect(
      isDispatchEligible(issue, config, {
        running: new Set([issue.id]),
        claimed: new Set(),
      }),
    ).toBe(false);
    expect(
      isDispatchEligible(issue, config, {
        running: new Set(),
        claimed: new Set([issue.id]),
      }),
    ).toBe(false);
  });

  it("blocks Todo issues with non-terminal blockers only", () => {
    const blocked = makeIssue({
      labels: ["ai-ready"],
      blockedBy: [
        { id: "I_9", identifier: "repo-9", state: "Todo", terminal: false },
      ],
    });
    expect(isDispatchEligible(blocked, config, emptyState)).toBe(false);

    const terminalBlocker = makeIssue({
      labels: ["ai-ready"],
      blockedBy: [
        { id: "I_9", identifier: "repo-9", state: "Done", terminal: true },
      ],
    });
    expect(isDispatchEligible(terminalBlocker, config, emptyState)).toBe(true);

    const inProgress = makeIssue({
      labels: ["ai-ready"],
      state: "In Progress",
      blockedBy: [
        { id: "I_9", identifier: "repo-9", state: "Todo", terminal: false },
      ],
    });
    expect(isDispatchEligible(inProgress, config, emptyState)).toBe(true);
  });
});

describe("tick dispatch (SPEC §8.1, §8.3)", () => {
  it("dispatches eligible issues in sorted order up to the global limit", async () => {
    const issues = [
      makeIssue({ id: "I_1", identifier: "repo-1", priority: 2 }),
      makeIssue({ id: "I_2", identifier: "repo-2", priority: 1 }),
      makeIssue({ id: "I_3", identifier: "repo-3", priority: 3 }),
    ];
    const config = makeConfig({ agent: { max_concurrent_agents: 2 } });
    const { orchestrator, runWorker } = makeOrchestrator(issues, {
      config: () => config,
    });
    await orchestrator.tick();
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runWorker.mock.calls.map((c) => (c[0] as Issue).identifier)).toEqual(
      ["repo-2", "repo-1"],
    );
    expect(orchestrator.running.size).toBe(2);
    expect(orchestrator.claimed.size).toBe(2);
  });

  it("enforces per-state concurrency overrides", async () => {
    const issues = [
      makeIssue({ id: "I_1", identifier: "repo-1", state: "In Progress" }),
      makeIssue({ id: "I_2", identifier: "repo-2", state: "In Progress" }),
      makeIssue({ id: "I_3", identifier: "repo-3", state: "Todo" }),
    ];
    const config = makeConfig({
      agent: { max_concurrent_agents_by_state: { "in progress": 1 } },
    });
    const never = () => new Promise<void>(() => {});
    const { orchestrator, runWorker } = makeOrchestrator(issues, {
      config: () => config,
      runWorker: vi.fn(never),
    });
    await orchestrator.tick();
    const dispatched = runWorker.mock.calls.map(
      (c) => (c[0] as Issue).identifier,
    );
    expect(dispatched).toContain("repo-3");
    expect(dispatched.filter((d) => d !== "repo-3")).toHaveLength(1);
  });

  it("does not double-dispatch an issue claimed in the same tick", async () => {
    const issue = makeIssue();
    const { orchestrator, runWorker } = makeOrchestrator(
      [issue, { ...issue }],
      {
        runWorker: vi.fn(() => new Promise<void>(() => {})),
      },
    );
    await orchestrator.tick();
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("schedules a continuation retry after a normal worker exit, keeping the claim", async () => {
    const issue = makeIssue();
    const { orchestrator, clock } = makeOrchestrator([issue]);
    await orchestrator.tick();
    await settle();
    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.completed.has(issue.id)).toBe(true);
    // SPEC §8.4: a 1s continuation retry is armed; the issue stays claimed.
    expect(orchestrator.claimed.has(issue.id)).toBe(true);
    expect(clock.delays()).toEqual([1000]);
  });

  it("releases the claim when the continuation retry finds the issue gone", async () => {
    let candidates: Issue[] = [makeIssue()];
    const { orchestrator, clock, runWorker } = makeOrchestrator(
      async () => candidates,
    );
    await orchestrator.tick();
    await settle();
    expect(runWorker).toHaveBeenCalledTimes(1);

    // Issue left the board before the continuation retry fires.
    candidates = [];
    await clock.fireAll();
    expect(orchestrator.claimed.size).toBe(0);
    expect(orchestrator.running.size).toBe(0);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("re-dispatches via the continuation retry when the issue is still active", async () => {
    const issue = makeIssue();
    const { orchestrator, clock, runWorker } = makeOrchestrator([issue]);
    await orchestrator.tick();
    await settle();
    expect(runWorker).toHaveBeenCalledTimes(1);

    await clock.fireAll();
    expect(runWorker).toHaveBeenCalledTimes(2);
  });

  it("schedules a backoff retry after a worker failure without marking completion", async () => {
    const issue = makeIssue();
    const { orchestrator, clock } = makeOrchestrator([issue], {
      runWorker: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await orchestrator.tick();
    await settle();
    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.completed.has(issue.id)).toBe(false);
    // SPEC §8.4: first failure backoff is 10s; claim retained for the retry.
    expect(orchestrator.claimed.has(issue.id)).toBe(true);
    expect(clock.delays()).toEqual([10000]);
  });

  it("escalates the backoff across repeated failures", async () => {
    const issue = makeIssue();
    const { orchestrator, clock } = makeOrchestrator([issue], {
      runWorker: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await orchestrator.tick();
    await settle();
    expect(clock.delays()).toEqual([10000]); // attempt 1

    await clock.fireAll(); // retry re-dispatches, fails again → attempt 2
    await settle();
    expect(clock.delays()).toEqual([20000]);
  });

  it("requeues a continuation retry with the short delay when no slots are available", async () => {
    const issue = makeIssue();
    const config = makeConfig({ agent: { max_concurrent_agents: 1 } });
    // A long-running blocker occupies the only slot.
    const blocker = makeIssue({ id: "I_block", identifier: "repo-9" });
    const { orchestrator, clock } = makeOrchestrator([issue], {
      config: () => config,
      runWorker: vi.fn((iss: Issue) =>
        iss.id === "I_block" ? new Promise<void>(() => {}) : Promise.resolve(),
      ),
    });
    await orchestrator.tick(); // dispatch issue (clean exit → continuation retry)
    await settle();

    // Occupy the slot, then fire the continuation retry: no slot → requeue.
    orchestrator.dispatch(blocker, null);
    expect(orchestrator.availableSlots(config)).toBe(0);
    await clock.fireAll();
    expect(orchestrator.claimed.has(issue.id)).toBe(true);
    // Continuation retry requeue uses the short fixed delay (failureAttempt=0).
    expect(clock.delays()).toContain(1000);
  });

  it("preserves the backoff delay when a failure retry is requeued due to slot exhaustion", async () => {
    const issue = makeIssue();
    const config = makeConfig({ agent: { max_concurrent_agents: 1 } });
    const blocker = makeIssue({ id: "I_block", identifier: "repo-9" });
    const { orchestrator, clock } = makeOrchestrator([issue], {
      config: () => config,
      runWorker: vi.fn(async (iss: Issue) => {
        if (iss.id !== "I_block") throw new Error("boom");
        return new Promise<void>(() => {});
      }),
    });
    await orchestrator.tick(); // dispatch issue (fails → 10s backoff retry)
    await settle();
    expect(clock.delays()).toEqual([10000]);

    // Occupy the slot before the backoff retry fires.
    orchestrator.dispatch(blocker, null);
    expect(orchestrator.availableSlots(config)).toBe(0);
    await clock.fireAll(); // no slot → requeue; must preserve 10s, not drop to 1s
    expect(orchestrator.claimed.has(issue.id)).toBe(true);
    expect(clock.delays()).toContain(10000);
  });

  it("skips the tick on candidate fetch failure without crashing (SPEC §11.4)", async () => {
    const { orchestrator, runWorker } = makeOrchestrator(async () => {
      throw new Error("api down");
    });
    await expect(orchestrator.tick()).resolves.toBeUndefined();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("skips dispatch when preflight validation fails (SPEC §6.3)", async () => {
    const { orchestrator, fetchCandidateIssues, runWorker } = makeOrchestrator(
      [makeIssue()],
      {
        validate: () => ({
          ok: false,
          errors: [{ code: "missing_tracker_token", message: "x" }],
        }),
      },
    );
    await orchestrator.tick();
    expect(fetchCandidateIssues).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });
});

describe("agent updates and token accounting (SPEC §13.5)", () => {
  it("tracks session id, last event, and accumulates usage", async () => {
    const issue = makeIssue();
    let emit:
      | ((event: Parameters<Orchestrator["onAgentUpdate"]>[1]) => void)
      | null = null;
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: vi.fn((_, __, onEvent) => {
        emit = onEvent;
        return new Promise<void>(() => {});
      }),
    });
    await orchestrator.tick();
    expect(emit).not.toBeNull();

    emit?.({
      event: "session_started",
      timestamp: "t",
      payload: { session_id: "sess-1" },
    });
    emit?.({
      event: "turn_completed",
      timestamp: "t",
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    const entry = orchestrator.running.get(issue.id);
    expect(entry?.sessionId).toBe("sess-1");
    expect(entry?.lastEvent).toBe("turn_completed");
    expect(entry?.inputTokens).toBe(100);
    expect(entry?.totalTokens).toBe(140);
    expect(orchestrator.totals.totalTokens).toBe(140);
  });
});

describe("reconciliation (SPEC §8.5)", () => {
  /** A worker that hangs until the orchestrator aborts it, then rejects. */
  function abortableWorker() {
    return vi.fn(
      (_i: Issue, _a: number | null, _e: unknown, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
  }

  it("kills a stalled run and arms a backoff retry (Part A)", async () => {
    let nowMs = 1_000_000;
    const issue = makeIssue();
    const { orchestrator, clock } = makeOrchestrator([issue], {
      runWorker: abortableWorker(),
      now: () => nowMs,
    });
    orchestrator.dispatch(issue, null);
    expect(orchestrator.running.size).toBe(1);

    nowMs += 300000 + 1; // past the default 300000 stall_timeout_ms
    await orchestrator.reconcile();
    await settle();

    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.claimed.has(issue.id)).toBe(true);
    expect(clock.delays()).toEqual([10000]);
  });

  it("does not stall-kill when stall detection is disabled (<=0)", async () => {
    let nowMs = 1_000_000;
    const issue = makeIssue();
    const config = makeConfig({ claude_code: { stall_timeout_ms: 0 } });
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: abortableWorker(),
      config: () => config,
      now: () => nowMs,
    });
    orchestrator.dispatch(issue, null);
    nowMs += 10_000_000;
    await orchestrator.reconcile();
    await settle();
    expect(orchestrator.running.size).toBe(1);
  });

  it("stops and cleans up a run whose issue went terminal (Part B)", async () => {
    const issue = makeIssue();
    const cleanup = vi.fn(async () => {});
    const fetchIssueStatesByIds = vi.fn(async () => [
      makeIssue({ id: issue.id, state: "Done" }),
    ]);
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: abortableWorker(),
      cleanupWorkspace: cleanup,
      tracker: {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssueStatesByIds,
      },
    });
    orchestrator.dispatch(issue, null);
    await orchestrator.reconcile();
    await settle();

    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.claimed.has(issue.id)).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    // Terminal stop is not a failure: no retry armed.
    expect(orchestrator.retries.size).toBe(0);
  });

  it("stops without cleanup when the issue is no longer active (label/state)", async () => {
    const issue = makeIssue({ labels: ["ai-ready"] });
    const config = makeConfig({ tracker: { required_labels: ["ai-ready"] } });
    const cleanup = vi.fn(async () => {});
    const fetchIssueStatesByIds = vi.fn(async () => [
      makeIssue({ id: issue.id, state: "Todo", labels: [] }), // label removed
    ]);
    const { orchestrator } = makeOrchestrator([issue], {
      config: () => config,
      runWorker: abortableWorker(),
      cleanupWorkspace: cleanup,
      tracker: {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssueStatesByIds,
      },
    });
    orchestrator.dispatch(issue, null);
    await orchestrator.reconcile();
    await settle();

    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.claimed.has(issue.id)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(orchestrator.retries.size).toBe(0);
  });

  it("updates the snapshot and keeps working while the issue stays active", async () => {
    const issue = makeIssue({ state: "Todo" });
    const fetchIssueStatesByIds = vi.fn(async () => [
      makeIssue({ id: issue.id, state: "In Progress" }),
    ]);
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: abortableWorker(),
      tracker: {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssueStatesByIds,
      },
    });
    orchestrator.dispatch(issue, null);
    await orchestrator.reconcile();
    await settle();

    expect(orchestrator.running.size).toBe(1);
    expect(orchestrator.running.get(issue.id)?.issue.state).toBe("In Progress");
  });

  it("keeps workers running when the reconciliation refresh fails", async () => {
    const issue = makeIssue();
    const fetchIssueStatesByIds = vi.fn(async () => {
      throw new Error("api down");
    });
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: abortableWorker(),
      tracker: {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssueStatesByIds,
      },
    });
    orchestrator.dispatch(issue, null);
    await orchestrator.reconcile();
    await settle();
    expect(orchestrator.running.size).toBe(1);
  });
});

describe("stopAll", () => {
  /** A worker that hangs until aborted. */
  function abortableWorker() {
    return vi.fn(
      (_i: Issue, _a: number | null, _e: unknown, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
  }

  it("aborts all running workers and resolves when they finish", async () => {
    const issues = [makeIssue({ id: "a" }), makeIssue({ id: "b" })];
    const { orchestrator } = makeOrchestrator(issues, {
      runWorker: abortableWorker(),
      tracker: {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssueStatesByIds: vi.fn(async () => []),
      },
    });
    orchestrator.dispatch(issues[0], null);
    orchestrator.dispatch(issues[1], null);
    expect(orchestrator.running.size).toBe(2);

    await orchestrator.stopAll();

    expect(orchestrator.running.size).toBe(0);
  });

  it("cancels pending retry timers", async () => {
    const issue = makeIssue();
    const { orchestrator, clock } = makeOrchestrator([issue], {
      runWorker: vi.fn(async () => {}),
    });
    await orchestrator.tick();
    await settle();
    expect(clock.pendingCount()).toBeGreaterThan(0);

    await orchestrator.stopAll();

    expect(clock.pendingCount()).toBe(0);
  });

  it("resolves immediately when no workers are running", async () => {
    const { orchestrator } = makeOrchestrator([]);
    await expect(orchestrator.stopAll()).resolves.toBeUndefined();
  });
});
