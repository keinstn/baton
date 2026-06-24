import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewConfig } from "../scripts/review/config.js";
import { setupWorkspace } from "../scripts/review/workspace.js";
import type { Platform } from "../src/platform/platform.js";
import * as platformModule from "../src/platform/platform.js";
import { makeIssue, silentLogger } from "./helpers.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "baton-review-ws-"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function makeReviewConfig(
  root: string,
  hooks: { afterCreate?: string | null; beforeRun?: string | null } = {},
): ReviewConfig {
  return {
    tracker: {
      token: "test-token",
      owner: "acme",
      ownerType: "organization",
      projectNumber: 1,
      statusField: "Status",
      activeStates: ["Todo"],
      repos: null,
    },
    workspace: {
      root,
      hookTimeoutMs: 2000,
    },
    hooks: {
      afterCreate: hooks.afterCreate ?? null,
      beforeRun: hooks.beforeRun ?? null,
    },
    agent: {
      kind: "copilot",
      timeoutMs: 300000,
      model: null,
      maxConcurrent: 1,
    },
    copilot: {
      allowAllTools: false,
      allowTools: [],
    },
    claudeCode: {
      permissionMode: "bypassPermissions",
      denyTools: [],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupWorkspace", () => {
  it("creates a missing workspace, runs after_create, and returns the workspace path", async () => {
    const root = await tempRoot();
    const issue = makeIssue();
    const config = makeReviewConfig(root, {
      afterCreate: 'echo "created" > created.txt',
    });

    const workspacePath = await setupWorkspace(issue, config, silentLogger);

    expect(workspacePath).toBe(join(root, issue.identifier));
    expect(
      await readFile(join(workspacePath, "created.txt"), "utf8"),
    ).toContain("created");
  });

  it("skips after_create on revisit and runs before_run each time", async () => {
    const root = await tempRoot();
    const issue = makeIssue();
    const config = makeReviewConfig(root, {
      afterCreate: 'echo "create" >> create.log',
      beforeRun: 'echo "before" >> before.log',
    });

    const workspacePath = await setupWorkspace(issue, config, silentLogger);
    await setupWorkspace(issue, config, silentLogger);

    const created = await readFile(join(workspacePath, "create.log"), "utf8");
    const before = await readFile(join(workspacePath, "before.log"), "utf8");
    expect(created.trim().split("\n")).toHaveLength(1);
    expect(before.trim().split("\n")).toHaveLength(2);
  });

  it("fails with a clear error when the workspace path exists as a file", async () => {
    const root = await tempRoot();
    const issue = makeIssue();
    await writeFile(join(root, issue.identifier), "occupied");
    const config = makeReviewConfig(root);

    await expect(setupWorkspace(issue, config, silentLogger)).rejects.toThrow(
      /workspace path exists and is not a directory/,
    );
  });

  it("removes workspace when after_create fails", async () => {
    const root = await tempRoot();
    const issue = makeIssue();
    const config = makeReviewConfig(root, {
      afterCreate: 'echo "stale" > stale.txt; exit 1',
    });

    await expect(setupWorkspace(issue, config, silentLogger)).rejects.toThrow(
      /after_create hook failed/,
    );
    expect(await exists(join(root, issue.identifier))).toBe(false);
  });

  it("includes cleanup failure details when after_create and cleanup both fail", async () => {
    const root = await tempRoot();
    const config = makeReviewConfig(root, {
      afterCreate: "exit 1",
    });
    const real = platformModule.makePlatform();
    const fakePlatform: Platform = {
      ...real,
      removeDir: vi.fn().mockRejectedValueOnce(new Error("cleanup failed")),
    };
    vi.spyOn(platformModule, "makePlatform").mockReturnValue(fakePlatform);

    await expect(
      setupWorkspace(makeIssue(), config, silentLogger),
    ).rejects.toThrow(/workspace cleanup failed: Error: cleanup failed/);
  });

  it("rejects workspace paths that escape the root", async () => {
    const root = await tempRoot();
    const config = makeReviewConfig(root);

    await expect(
      setupWorkspace(makeIssue({ identifier: ".." }), config, silentLogger),
    ).rejects.toThrow(/escapes workspace root/);
  });

  it("fails when before_run hook exits non-zero", async () => {
    const root = await tempRoot();
    const config = makeReviewConfig(root, {
      beforeRun: "exit 2",
    });

    await expect(
      setupWorkspace(makeIssue(), config, silentLogger),
    ).rejects.toThrow(/before_run hook failed/);
  });

  it("passes bash and native workspace paths to hooks", async () => {
    const root = await tempRoot();
    const config = makeReviewConfig(root, {
      afterCreate:
        'printf "%s|%s" "$BATON_WORKSPACE" "$BATON_WORKSPACE_NATIVE" > env.txt',
    });
    const real = platformModule.makePlatform();
    const fakePlatform: Platform = {
      ...real,
      toBashPath: (p: string) => `bash:${p}`,
      nativePath: (p: string) => `native:${p}`,
    };
    vi.spyOn(platformModule, "makePlatform").mockReturnValue(fakePlatform);

    const workspacePath = await setupWorkspace(
      makeIssue(),
      config,
      silentLogger,
    );
    const env = await readFile(join(workspacePath, "env.txt"), "utf8");
    expect(env).toBe(`bash:${workspacePath}|native:${workspacePath}`);
  });
});
