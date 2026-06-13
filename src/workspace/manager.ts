import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BatonConfig } from "../config/schema.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import type { Issue } from "../tracker/types.js";
import { toBashPath } from "../util.js";
import { runHookScript } from "./hooks.js";

const WORKSPACE_REMOVE_RETRY_MS = 100;
const WORKSPACE_REMOVE_RETRY_WINDOW_MS = 5000;

function isTransientWindowsRmError(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  const code = err.code;
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "ENOTEMPTY" ||
    code === "UNKNOWN"
  );
}

/** SPEC §4.2 / §9.5 Invariant 3: only [A-Za-z0-9._-] in workspace names. */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export class WorkspaceManager {
  private root: string;

  constructor(
    private config: BatonConfig,
    private readonly logger: Logger,
  ) {
    this.root = path.resolve(config.workspace.root);
  }

  /**
   * Apply a new config; hooks take effect on the next call. A changed
   * workspace.root takes effect for new workspaces only — in-flight workspaces
   * remain at the old root path (SPEC §6.2).
   */
  applyConfig(cfg: BatonConfig): void {
    const newRoot = path.resolve(cfg.workspace.root);
    if (newRoot !== this.root) {
      this.logger.warn(
        "workspace.root changed; takes effect for new workspaces only — in-flight workspaces remain at the old root path",
        { old_root: this.root, new_root: newRoot },
      );
      this.root = newRoot;
    }
    this.config = cfg;
  }

  /** Compute the per-issue workspace path, enforcing root containment (SPEC §9.5 Invariant 2). */
  pathFor(identifier: string): string {
    const key = sanitizeWorkspaceKey(identifier);
    const p = path.resolve(this.root, key);
    if (p === this.root || !p.startsWith(this.root + path.sep)) {
      throw new BatonError(
        "workspace_outside_root",
        `workspace path for ${identifier} escapes workspace root`,
      );
    }
    return p;
  }

  hookEnv(
    issue: Issue,
    workspacePath: string,
    platform = process.platform,
  ): Record<string, string> {
    return {
      BATON_ISSUE_ID: issue.id,
      BATON_ISSUE_IDENTIFIER: issue.identifier,
      BATON_ISSUE_NUMBER: String(issue.number),
      BATON_ISSUE_REPO: issue.repository,
      BATON_ISSUE_URL: issue.url ?? "",
      BATON_ISSUE_STATUS: issue.state,
      BATON_WORKSPACE: toBashPath(workspacePath, platform),
      ...(platform === "win32"
        ? { BATON_WORKSPACE_NATIVE: workspacePath }
        : {}),
    };
  }

  private async removeWorkspaceDir(workspacePath: string): Promise<void> {
    const deadline = Date.now() + WORKSPACE_REMOVE_RETRY_WINDOW_MS;
    for (;;) {
      try {
        await rm(workspacePath, { recursive: true, force: true });
        return;
      } catch (err) {
        if (
          process.platform !== "win32" ||
          !isTransientWindowsRmError(err) ||
          Date.now() >= deadline
        ) {
          throw err;
        }
        await delay(WORKSPACE_REMOVE_RETRY_MS);
      }
    }
  }

  /** Create or reuse the workspace for an issue (SPEC §9.2). */
  async createForIssue(issue: Issue): Promise<Workspace> {
    const workspacePath = this.pathFor(issue.identifier);
    const workspaceKey = path.basename(workspacePath);
    const log = this.logger.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });

    let createdNow = false;
    let existing: { isDirectory(): boolean } | null = null;
    try {
      existing = await stat(workspacePath);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (!existing.isDirectory()) {
        throw new BatonError(
          "workspace_not_directory",
          `workspace path exists and is not a directory: ${workspacePath}`,
        );
      }
    } else {
      await mkdir(workspacePath, { recursive: true });
      createdNow = true;
      if (this.config.hooks.afterCreate) {
        log.info("running after_create hook", { workspace: workspacePath });
        const result = await runHookScript(this.config.hooks.afterCreate, {
          cwd: workspacePath,
          env: this.hookEnv(issue, workspacePath),
          timeoutMs: this.config.hooks.timeoutMs,
        });
        if (!result.ok) {
          // SPEC §9.4: after_create failure is fatal to workspace creation;
          // remove the partially prepared directory (SPEC §9.3).
          await this.removeWorkspaceDir(workspacePath);
          throw new BatonError(
            "hook_failed",
            `after_create hook failed (timedOut=${result.timedOut} code=${result.code}): ${result.output.slice(0, 500)}`,
          );
        }
      }
    }
    return { path: workspacePath, workspaceKey, createdNow };
  }

  /** before_run: failure aborts the current attempt (SPEC §9.4). */
  async runBeforeRun(issue: Issue, workspacePath: string): Promise<void> {
    if (!this.config.hooks.beforeRun) return;
    const result = await runHookScript(this.config.hooks.beforeRun, {
      cwd: workspacePath,
      env: this.hookEnv(issue, workspacePath),
      timeoutMs: this.config.hooks.timeoutMs,
    });
    if (!result.ok) {
      throw new BatonError(
        "hook_failed",
        `before_run hook failed (timedOut=${result.timedOut} code=${result.code}): ${result.output.slice(0, 500)}`,
      );
    }
  }

  /** after_run: failure is logged and ignored (SPEC §9.4). */
  async runAfterRun(issue: Issue, workspacePath: string): Promise<void> {
    if (!this.config.hooks.afterRun) return;
    const result = await runHookScript(this.config.hooks.afterRun, {
      cwd: workspacePath,
      env: this.hookEnv(issue, workspacePath),
      timeoutMs: this.config.hooks.timeoutMs,
    });
    if (!result.ok) {
      this.logger.warn("after_run hook failed (ignored)", {
        issue_identifier: issue.identifier,
        timed_out: result.timedOut,
        code: result.code,
      });
    }
  }

  /** Remove a terminal issue's workspace; before_remove failures are ignored (SPEC §9.4). */
  async cleanup(issue: Issue): Promise<void> {
    const workspacePath = this.pathFor(issue.identifier);
    let exists = false;
    try {
      exists = (await stat(workspacePath)).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) return;
    if (this.config.hooks.beforeRemove) {
      const result = await runHookScript(this.config.hooks.beforeRemove, {
        cwd: workspacePath,
        env: this.hookEnv(issue, workspacePath),
        timeoutMs: this.config.hooks.timeoutMs,
      });
      if (!result.ok) {
        this.logger.warn("before_remove hook failed (ignored)", {
          issue_identifier: issue.identifier,
          timed_out: result.timedOut,
          code: result.code,
        });
      }
    }
    await this.removeWorkspaceDir(workspacePath);
    this.logger.info("workspace removed", {
      issue_identifier: issue.identifier,
      workspace: workspacePath,
    });
  }
}
