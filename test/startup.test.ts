import { describe, expect, it, vi } from "vitest";
import { startupTerminalCleanup } from "../src/orchestrator/startup.js";
import type { Issue } from "../src/tracker/types.js";
import { makeConfig, makeIssue, silentLogger } from "./helpers.js";

describe("startupTerminalCleanup (SPEC §8.6)", () => {
  it("removes workspaces for every terminal-state issue", async () => {
    const issues = [
      makeIssue({ id: "I_1", identifier: "repo-1" }),
      makeIssue({ id: "I_2", identifier: "repo-2" }),
    ];
    const cleanup = vi.fn(async () => {});
    const fetchIssuesByStates = vi.fn(async () => issues);

    await startupTerminalCleanup({
      tracker: { fetchIssuesByStates },
      cleanupWorkspace: cleanup,
      config: () => makeConfig(),
      logger: silentLogger,
    });

    // Default terminal states are ["Done"].
    expect(fetchIssuesByStates).toHaveBeenCalledWith(["Done"]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls.map((c) => (c[0] as Issue).identifier)).toEqual([
      "repo-1",
      "repo-2",
    ]);
  });

  it("logs and continues when the terminal-issue fetch fails", async () => {
    const cleanup = vi.fn(async () => {});
    await expect(
      startupTerminalCleanup({
        tracker: {
          fetchIssuesByStates: async () => {
            throw new Error("api down");
          },
        },
        cleanupWorkspace: cleanup,
        config: () => makeConfig(),
        logger: silentLogger,
      }),
    ).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("continues the sweep after a per-issue cleanup failure", async () => {
    const issues = [
      makeIssue({ id: "I_1", identifier: "repo-1" }),
      makeIssue({ id: "I_2", identifier: "repo-2" }),
    ];
    let calls = 0;
    const cleanup = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("rm failed");
    });

    await startupTerminalCleanup({
      tracker: { fetchIssuesByStates: async () => issues },
      cleanupWorkspace: cleanup,
      config: () => makeConfig(),
      logger: silentLogger,
    });

    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("makes no API call when no terminal states are configured", async () => {
    const config = makeConfig({ tracker: { terminal_states: [] } });
    const fetchIssuesByStates = vi.fn(async () => [] as Issue[]);
    await startupTerminalCleanup({
      tracker: { fetchIssuesByStates },
      cleanupWorkspace: vi.fn(async () => {}),
      config: () => config,
      logger: silentLogger,
    });
    expect(fetchIssuesByStates).not.toHaveBeenCalled();
  });
});
