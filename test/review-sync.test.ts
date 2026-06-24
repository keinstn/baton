import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyItem } from "../scripts/review-sync/classify.js";
import {
  loadReviewSyncConfig,
  parseReviewSyncConfig,
} from "../scripts/review-sync/config.js";

const IN_PROGRESS = "In Progress";
const IN_REVIEW = "In Review";

describe("classifyItem — no open PRs", () => {
  it("skips when there are no linked open PRs", () => {
    expect(classifyItem([], "In Review", IN_PROGRESS, IN_REVIEW)).toEqual({
      action: "skip",
      reason: "no_open_prs",
    });
  });
});

describe("classifyItem — no review threads", () => {
  it("skips when the single open PR has no threads", () => {
    expect(
      classifyItem(
        [{ hasThreads: false, allResolved: true }],
        "In Review",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "skip", reason: "no_threads" });
  });

  it("skips when multiple open PRs all have no threads", () => {
    expect(
      classifyItem(
        [
          { hasThreads: false, allResolved: true },
          { hasThreads: false, allResolved: true },
        ],
        "In Review",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "skip", reason: "no_threads" });
  });
});

describe("classifyItem — unresolved threads", () => {
  it("moves to inProgressState when any PR has an unresolved thread", () => {
    expect(
      classifyItem(
        [{ hasThreads: true, allResolved: false }],
        "In Review",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "move", targetState: IN_PROGRESS });
  });

  it("moves to inProgressState even when another PR has all threads resolved", () => {
    expect(
      classifyItem(
        [
          { hasThreads: true, allResolved: true },
          { hasThreads: true, allResolved: false },
        ],
        "In Review",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "move", targetState: IN_PROGRESS });
  });

  it("returns noop when already in the inProgressState", () => {
    expect(
      classifyItem(
        [{ hasThreads: true, allResolved: false }],
        "In Progress",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "noop" });
  });
});

describe("classifyItem — all threads resolved", () => {
  it("moves to inReviewState when all threads on a single PR are resolved", () => {
    expect(
      classifyItem(
        [{ hasThreads: true, allResolved: true }],
        "In Progress",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "move", targetState: IN_REVIEW });
  });

  it("moves to inReviewState when all threads across multiple PRs are resolved", () => {
    expect(
      classifyItem(
        [
          { hasThreads: true, allResolved: true },
          { hasThreads: true, allResolved: true },
        ],
        "In Progress",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "move", targetState: IN_REVIEW });
  });

  it("returns noop when already in the inReviewState", () => {
    expect(
      classifyItem(
        [{ hasThreads: true, allResolved: true }],
        "In Review",
        IN_PROGRESS,
        IN_REVIEW,
      ),
    ).toEqual({ action: "noop" });
  });
});

describe("classifyItem — state name normalisation", () => {
  it("treats target state comparison as case-insensitive and whitespace-trimmed", () => {
    expect(
      classifyItem(
        [{ hasThreads: true, allResolved: false }],
        "  in progress  ",
        "In Progress",
        "In Review",
      ),
    ).toEqual({ action: "noop" });
  });
});

describe("parseReviewSyncConfig defaults", () => {
  const BASE_RAW = {
    tracker: {
      owner: "acme",
      project_number: 1,
      source_states: ["In Review"],
    },
  };

  it("applies documented defaults", () => {
    const cfg = parseReviewSyncConfig(BASE_RAW, { GITHUB_TOKEN: "tok" });
    expect(cfg.token).toBe("tok");
    expect(cfg.endpoint).toBe("https://api.github.com/graphql");
    expect(cfg.ownerType).toBe("organization");
    expect(cfg.inProgressState).toBe("In Progress");
    expect(cfg.inReviewState).toBe("In Review");
    expect(cfg.owner).toBe("acme");
    expect(cfg.projectNumber).toBe(1);
    expect(cfg.sourceStates).toEqual(["In Review"]);
  });

  it("resolves token to null when GITHUB_TOKEN is unset", () => {
    const cfg = parseReviewSyncConfig(BASE_RAW, {});
    expect(cfg.token).toBeNull();
  });

  it("throws when tracker.owner is missing", () => {
    expect(() =>
      parseReviewSyncConfig({ tracker: { project_number: 1 } }, {}),
    ).toThrow(/tracker\.owner/);
  });

  it("throws when tracker.project_number is missing", () => {
    expect(() =>
      parseReviewSyncConfig({ tracker: { owner: "acme" } }, {}),
    ).toThrow(/tracker\.project_number/);
  });

  it("throws when tracker.source_states is empty", () => {
    expect(() =>
      parseReviewSyncConfig(
        { tracker: { owner: "acme", project_number: 1, source_states: [] } },
        {},
      ),
    ).toThrow(/tracker\.source_states/);
  });

  it("throws on invalid owner_type", () => {
    expect(() =>
      parseReviewSyncConfig(
        {
          tracker: {
            owner: "acme",
            project_number: 1,
            owner_type: "organisation",
          },
        },
        {},
      ),
    ).toThrow(/tracker\.owner_type/);
  });
});

describe("loadReviewSyncConfig", () => {
  it("parses a valid REVIEW_SYNC.md and returns config", async () => {
    const content = [
      "---",
      "tracker:",
      "  owner: myorg",
      "  project_number: 7",
      "  source_states:",
      "    - In Review",
      "    - Agent Review",
      "  in_progress_state: In Progress",
      "  in_review_state: In Review",
      "---",
      "Optional body text.",
    ].join("\n");

    const filePath = join(tmpdir(), `review-sync-test-${Date.now()}.md`);
    await writeFile(filePath, content, "utf8");

    const cfg = await loadReviewSyncConfig(filePath, {
      GITHUB_TOKEN: "ghp_test",
    });

    expect(cfg.owner).toBe("myorg");
    expect(cfg.projectNumber).toBe(7);
    expect(cfg.sourceStates).toEqual(["In Review", "Agent Review"]);
    expect(cfg.inProgressState).toBe("In Progress");
    expect(cfg.inReviewState).toBe("In Review");
    expect(cfg.token).toBe("ghp_test");
  });

  it("throws on missing file", async () => {
    await expect(
      loadReviewSyncConfig("/nonexistent/REVIEW_SYNC.md"),
    ).rejects.toThrow(/cannot read review-sync file/);
  });
});
