import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBatonError } from "../src/errors.js";
import { loadWorkflow, parseWorkflow } from "../src/workflow/loader.js";

describe("parseWorkflow (SPEC §5.2)", () => {
  it("splits YAML front matter and trimmed prompt body", () => {
    const text =
      "---\ntracker:\n  kind: github_projects\n---\n\nDo the work.\n\n";
    const result = parseWorkflow(text);
    expect(result.config).toEqual({ tracker: { kind: "github_projects" } });
    expect(result.promptTemplate).toBe("Do the work.");
  });

  it("treats a file without front matter as prompt body with empty config", () => {
    const result = parseWorkflow("Just a prompt.\n");
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Just a prompt.");
  });

  it("returns empty config for empty front matter", () => {
    const result = parseWorkflow("---\n---\nbody");
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("body");
  });

  it("rejects non-map front matter", () => {
    expect.assertions(1);
    try {
      parseWorkflow("---\n- a\n- b\n---\nbody");
    } catch (err) {
      expect(isBatonError(err, "workflow_front_matter_not_a_map")).toBe(true);
    }
  });

  it("rejects invalid YAML", () => {
    expect.assertions(1);
    try {
      parseWorkflow("---\nfoo: [unclosed\n---\nbody");
    } catch (err) {
      expect(isBatonError(err, "workflow_parse_error")).toBe(true);
    }
  });

  it("rejects unterminated front matter", () => {
    expect.assertions(1);
    try {
      parseWorkflow("---\nfoo: bar\nbody");
    } catch (err) {
      expect(isBatonError(err, "workflow_parse_error")).toBe(true);
    }
  });
});

describe("loadWorkflow (SPEC §5.1)", () => {
  it("loads a workflow file and records its directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baton-wf-"));
    const path = join(dir, "WORKFLOW.md");
    await writeFile(path, "---\npolling:\n  interval_ms: 1000\n---\nprompt");
    const wf = await loadWorkflow(path);
    expect(wf.config).toEqual({ polling: { interval_ms: 1000 } });
    expect(wf.promptTemplate).toBe("prompt");
    expect(wf.dir).toBe(dir);
  });

  it("returns missing_workflow_file for unreadable paths", async () => {
    await expect(
      loadWorkflow("/nonexistent/WORKFLOW.md"),
    ).rejects.toMatchObject({
      code: "missing_workflow_file",
    });
  });
});

describe("example workflows", () => {
  it("documents base-branch conflict handling for feedback-loop reruns", async () => {
    const text = await readFile(
      new URL("../examples/WORKFLOW.md", import.meta.url),
      "utf8",
    );

    expect(text).toContain(
      'If an open PR already exists for this branch and the issue status is not "Rework"',
    );
    expect(text).toContain(
      "BASE_BRANCH=$(gh pr view --json baseRefName --jq '.baseRefName')",
    );
    expect(text).toContain('git merge --no-edit "origin/$BASE_BRANCH"');
    expect(text).toContain("Reflect the merge with a normal `git push`");
  });
});
