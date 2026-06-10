import { describe, expect, it, vi } from "vitest";
import {
  isDispatchEligible,
  Orchestrator,
  sortForDispatch,
  type OrchestratorDeps,
} from "../src/orchestrator/orchestrator.js";
import type { Issue } from "../src/tracker/types.js";
import { makeConfig, makeIssue, silentLogger } from "./helpers.js";

const emptyState = { running: new Set<string>(), claimed: new Set<string>() };

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeOrchestrator(
  issues: Issue[] | (() => Promise<Issue[]>),
  overrides: Partial<OrchestratorDeps> = {},
) {
  const config = overrides.config?.() ?? makeConfig();
  const fetchCandidateIssues =
    typeof issues === "function" ? vi.fn(issues) : vi.fn(async () => issues);
  const deps: OrchestratorDeps = {
    tracker: { fetchCandidateIssues },
    runWorker: vi.fn(async () => {}),
    validate: () => ({ ok: true, errors: [] }),
    config: () => config,
    logger: silentLogger,
    ...overrides,
  };
  return {
    orchestrator: new Orchestrator(deps),
    fetchCandidateIssues,
    runWorker: deps.runWorker as ReturnType<typeof vi.fn>,
  };
}

describe("sortForDispatch (SPEC §8.2)", () => {
  it("orders by priority, then created_at, then identifier", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "repo-3", priority: null, createdAt: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "b", identifier: "repo-2", priority: 2, createdAt: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "c", identifier: "repo-1", priority: 1, createdAt: "2026-01-02T00:00:00Z" }),
      makeIssue({ id: "d", identifier: "repo-5", priority: 1, createdAt: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "e", identifier: "repo-4", priority: 1, createdAt: "2026-01-01T00:00:00Z" }),
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
    expect(isDispatchEligible(makeIssue({ labels: ["ai-ready"] }), config, emptyState)).toBe(true);
    expect(isDispatchEligible(makeIssue({ labels: [] }), config, emptyState)).toBe(false);
    expect(
      isDispatchEligible(makeIssue({ labels: ["ai-ready"], state: "Done" }), config, emptyState),
    ).toBe(false);
    expect(
      isDispatchEligible(makeIssue({ labels: ["ai-ready"], state: "" }), config, emptyState),
    ).toBe(false);
    expect(
      isDispatchEligible(makeIssue({ labels: ["ai-ready"], closed: true }), config, emptyState),
    ).toBe(false);
  });

  it("compares states case-insensitively", () => {
    expect(
      isDispatchEligible(makeIssue({ labels: ["ai-ready"], state: "todo" }), config, emptyState),
    ).toBe(true);
  });

  it("a blank configured label matches no issue", () => {
    const blank = makeConfig({ tracker: { required_labels: [" "] } });
    expect(isDispatchEligible(makeIssue({ labels: ["x"] }), blank, emptyState)).toBe(false);
  });

  it("applies the repos filter", () => {
    const repos = makeConfig({ tracker: { repos: ["acme/other"] } });
    expect(isDispatchEligible(makeIssue(), repos, emptyState)).toBe(false);
  });

  it("skips issues already running or claimed", () => {
    const issue = makeIssue({ labels: ["ai-ready"] });
    expect(
      isDispatchEligible(issue, config, { running: new Set([issue.id]), claimed: new Set() }),
    ).toBe(false);
    expect(
      isDispatchEligible(issue, config, { running: new Set(), claimed: new Set([issue.id]) }),
    ).toBe(false);
  });

  it("blocks Todo issues with non-terminal blockers only", () => {
    const blocked = makeIssue({
      labels: ["ai-ready"],
      blockedBy: [{ id: "I_9", identifier: "repo-9", state: "Todo", terminal: false }],
    });
    expect(isDispatchEligible(blocked, config, emptyState)).toBe(false);

    const terminalBlocker = makeIssue({
      labels: ["ai-ready"],
      blockedBy: [{ id: "I_9", identifier: "repo-9", state: "Done", terminal: true }],
    });
    expect(isDispatchEligible(terminalBlocker, config, emptyState)).toBe(true);

    const inProgress = makeIssue({
      labels: ["ai-ready"],
      state: "In Progress",
      blockedBy: [{ id: "I_9", identifier: "repo-9", state: "Todo", terminal: false }],
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
    const { orchestrator, runWorker } = makeOrchestrator(issues, { config: () => config });
    await orchestrator.tick();
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runWorker.mock.calls.map((c) => (c[0] as Issue).identifier)).toEqual([
      "repo-2",
      "repo-1",
    ]);
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
    const dispatched = runWorker.mock.calls.map((c) => (c[0] as Issue).identifier);
    expect(dispatched).toContain("repo-3");
    expect(dispatched.filter((d) => d !== "repo-3")).toHaveLength(1);
  });

  it("does not double-dispatch an issue claimed in the same tick", async () => {
    const issue = makeIssue();
    const { orchestrator, runWorker } = makeOrchestrator([issue, { ...issue }], {
      runWorker: vi.fn(() => new Promise<void>(() => {})),
    });
    await orchestrator.tick();
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("releases the claim after a normal worker exit", async () => {
    const issue = makeIssue();
    const { orchestrator } = makeOrchestrator([issue]);
    await orchestrator.tick();
    await settle();
    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.claimed.size).toBe(0);
    expect(orchestrator.completed.has(issue.id)).toBe(true);
  });

  it("releases the claim after a worker failure without marking completion", async () => {
    const issue = makeIssue();
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await orchestrator.tick();
    await settle();
    expect(orchestrator.running.size).toBe(0);
    expect(orchestrator.claimed.size).toBe(0);
    expect(orchestrator.completed.has(issue.id)).toBe(false);
  });

  it("skips the tick on candidate fetch failure without crashing (SPEC §11.4)", async () => {
    const { orchestrator, runWorker } = makeOrchestrator(async () => {
      throw new Error("api down");
    });
    await expect(orchestrator.tick()).resolves.toBeUndefined();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("skips dispatch when preflight validation fails (SPEC §6.3)", async () => {
    const { orchestrator, fetchCandidateIssues, runWorker } = makeOrchestrator([makeIssue()], {
      validate: () => ({ ok: false, errors: [{ code: "missing_tracker_token", message: "x" }] }),
    });
    await orchestrator.tick();
    expect(fetchCandidateIssues).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });
});

describe("agent updates and token accounting (SPEC §13.5)", () => {
  it("tracks session id, last event, and accumulates usage", async () => {
    const issue = makeIssue();
    let emit: ((event: Parameters<Orchestrator["onAgentUpdate"]>[1]) => void) | null = null;
    const { orchestrator } = makeOrchestrator([issue], {
      runWorker: vi.fn((_, __, onEvent) => {
        emit = onEvent;
        return new Promise<void>(() => {});
      }),
    });
    await orchestrator.tick();
    expect(emit).not.toBeNull();

    emit!({
      event: "session_started",
      timestamp: "t",
      payload: { session_id: "sess-1" },
    });
    emit!({
      event: "turn_completed",
      timestamp: "t",
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    const entry = orchestrator.running.get(issue.id)!;
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.lastEvent).toBe("turn_completed");
    expect(entry.inputTokens).toBe(100);
    expect(entry.totalTokens).toBe(140);
    expect(orchestrator.totals.totalTokens).toBe(140);
  });
});
