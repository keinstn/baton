import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewConfig } from "../scripts/review/config.js";

function baseRaw(): Record<string, unknown> {
  return {
    tracker: {
      owner: "acme",
      project_number: 1,
      active_states: ["Todo"],
    },
    workspace: {
      root: "workspaces/review",
    },
    agent: {
      kind: "copilot",
    },
  };
}

describe("parseReviewConfig workspace root expansion", () => {
  it("resolves workspace.root relative to the REVIEW.md directory", () => {
    const config = parseReviewConfig(baseRaw(), {}, "/tmp/review-root");
    expect(config.workspace.root).toBe("/tmp/review-root/workspaces/review");
  });

  it("expands home marker with the shared expandPath behavior", () => {
    const raw = baseRaw();
    (raw.workspace as Record<string, unknown>).root = "~/review-workspaces";
    const config = parseReviewConfig(raw, {}, "/ignored");
    expect(config.workspace.root).toBe(
      path.join(os.homedir(), "review-workspaces"),
    );
  });
});
