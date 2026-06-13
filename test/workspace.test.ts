import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sanitizeWorkspaceKey,
  WorkspaceManager,
} from "../src/workspace/manager.js";
import { makeConfig, makeIssue, silentLogger } from "./helpers.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "baton-ws-"));
}

function manager(
  root: string,
  hooks: Record<string, unknown> = {},
): WorkspaceManager {
  const config = makeConfig({ workspace: { root }, hooks });
  return new WorkspaceManager(config, silentLogger);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("workspace key sanitization (SPEC §4.2)", () => {
  it("replaces characters outside [A-Za-z0-9._-]", () => {
    expect(sanitizeWorkspaceKey("repo-123")).toBe("repo-123");
    expect(sanitizeWorkspaceKey("a/b#c d")).toBe("a_b_c_d");
  });
});

describe("workspace paths (SPEC §9.1, §9.5)", () => {
  it("is deterministic per identifier", async () => {
    const root = await tempRoot();
    const m = manager(root);
    expect(m.pathFor("repo-1")).toBe(join(root, "repo-1"));
    expect(m.pathFor("repo-1")).toBe(m.pathFor("repo-1"));
  });

  it("rejects paths escaping the workspace root", async () => {
    const root = await tempRoot();
    const m = manager(root);
    expect(() => m.pathFor("..")).toThrowError(/escapes workspace root/);
  });
});

describe("workspace creation and hooks (SPEC §9.2, §9.4)", () => {
  it("creates a missing workspace and reuses an existing one", async () => {
    const root = await tempRoot();
    const m = manager(root);
    const issue = makeIssue();
    const first = await m.createForIssue(issue);
    expect(first.createdNow).toBe(true);
    const second = await m.createForIssue(issue);
    expect(second.createdNow).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("runs after_create only on new workspace creation", async () => {
    const root = await tempRoot();
    const m = manager(root, { after_create: "echo ran >> created.txt" });
    const issue = makeIssue();
    await m.createForIssue(issue);
    await m.createForIssue(issue);
    const content = await readFile(join(root, "repo-1", "created.txt"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });

  it("exposes BATON_* environment variables to hooks", async () => {
    const root = await tempRoot();
    const m = manager(root, {
      after_create:
        'printf "%s:%s:%s" "$BATON_ISSUE_IDENTIFIER" "$BATON_ISSUE_NUMBER" "$BATON_WORKSPACE" > meta.txt',
    });
    await m.createForIssue(makeIssue({ identifier: "repo-7", number: 7 }));
    const content = await readFile(join(root, "repo-7", "meta.txt"), "utf8");
    expect(content.trim()).toBe(`repo-7:7:${join(root, "repo-7")}`);
  });

  it("provides bash and native workspace paths for Windows hooks", async () => {
    const root = "C:\\baton\\workspaces";
    const m = manager("/tmp");
    expect(m.hookEnv(makeIssue(), `${root}\\repo-1`, "win32")).toMatchObject({
      BATON_WORKSPACE: "/c/baton/workspaces/repo-1",
      BATON_WORKSPACE_NATIVE: "C:\\baton\\workspaces\\repo-1",
    });
  });

  it("after_create failure aborts creation and removes the directory", async () => {
    const root = await tempRoot();
    const m = manager(root, { after_create: "exit 1" });
    await expect(m.createForIssue(makeIssue())).rejects.toMatchObject({
      code: "hook_failed",
    });
    expect(await exists(join(root, "repo-1"))).toBe(false);
  });

  it("after_create timeout is fatal", async () => {
    const root = await tempRoot();
    const config = makeConfig({
      workspace: { root },
      hooks: { after_create: "sleep 5", timeout_ms: 200 },
    });
    const m = new WorkspaceManager(config, silentLogger);
    await expect(m.createForIssue(makeIssue())).rejects.toMatchObject({
      code: "hook_failed",
    });
  });

  it("before_run failure aborts the attempt", async () => {
    const root = await tempRoot();
    const m = manager(root, { before_run: "exit 2" });
    const issue = makeIssue();
    const ws = await m.createForIssue(issue);
    await expect(m.runBeforeRun(issue, ws.path)).rejects.toMatchObject({
      code: "hook_failed",
    });
  });

  it("after_run failure is logged and ignored", async () => {
    const root = await tempRoot();
    const m = manager(root, { after_run: "exit 3" });
    const issue = makeIssue();
    const ws = await m.createForIssue(issue);
    await expect(m.runAfterRun(issue, ws.path)).resolves.toBeUndefined();
  });
});

describe("workspace cleanup (SPEC §9.4)", () => {
  it("removes the workspace even when before_remove fails", async () => {
    const root = await tempRoot();
    const m = manager(root, { before_remove: "exit 1" });
    const issue = makeIssue();
    const ws = await m.createForIssue(issue);
    await m.cleanup(issue);
    expect(await exists(ws.path)).toBe(false);
  });

  it("is a no-op for missing workspaces", async () => {
    const root = await tempRoot();
    const m = manager(root);
    await expect(m.cleanup(makeIssue())).resolves.toBeUndefined();
  });
});

describe("applyConfig (SPEC §6.2 hot-reload)", () => {
  it("updates hook config used on the next createForIssue call", async () => {
    const root = await tempRoot();
    const m = manager(root);

    // Apply a config with an after_create hook that writes a marker file.
    const markerPath = join(root, "hook-ran");
    const updatedConfig = makeConfig({
      workspace: { root },
      hooks: { after_create: 'touch "$BATON_WORKSPACE/../hook-ran"' },
    });
    m.applyConfig(updatedConfig);

    const issue = makeIssue({ identifier: "new-issue" });
    await m.createForIssue(issue);
    expect(await exists(markerPath)).toBe(true);
  });

  it("updates root and logs a warning when workspace.root changes", async () => {
    const oldRoot = await tempRoot();
    const newRoot = await tempRoot();

    const warnMessages: string[] = [];
    const { Logger } = await import("../src/observability/logger.js");
    const warnLogger = new Logger({}, (line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.level === "warn") warnMessages.push(String(entry.msg));
    });

    const config = makeConfig({ workspace: { root: oldRoot } });
    const m = new WorkspaceManager(config, warnLogger);

    const updatedConfig = makeConfig({ workspace: { root: newRoot } });
    m.applyConfig(updatedConfig);

    // New workspace should be created under newRoot.
    const issue = makeIssue({ identifier: "issue-after-root-change" });
    const ws = await m.createForIssue(issue);
    expect(ws.path.startsWith(newRoot)).toBe(true);

    // A warning should have been emitted about the root change.
    expect(
      warnMessages.some((msg) => msg.includes("workspace.root changed")),
    ).toBe(true);
  });

  it("does not log a warning when workspace.root is unchanged", async () => {
    const root = await tempRoot();

    const warnMessages: string[] = [];
    const { Logger } = await import("../src/observability/logger.js");
    const warnLogger = new Logger({}, (line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.level === "warn") warnMessages.push(String(entry.msg));
    });

    const config = makeConfig({ workspace: { root } });
    const m = new WorkspaceManager(config, warnLogger);
    m.applyConfig(config); // same config, same root

    expect(warnMessages).toHaveLength(0);
  });
});
