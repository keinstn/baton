import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../src/observability/logger.js";
import type { Issue } from "../../src/tracker/types.js";
import { runHookScript } from "../../src/workspace/hooks.js";
import { sanitizeWorkspaceKey } from "../../src/workspace/manager.js";
import type { ReviewConfig } from "./config.js";

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function hookEnv(issue: Issue, workspacePath: string): Record<string, string> {
  return {
    BATON_ISSUE_ID: issue.id,
    BATON_ISSUE_IDENTIFIER: issue.identifier,
    BATON_ISSUE_NUMBER: String(issue.number),
    BATON_ISSUE_REPO: issue.repository,
    BATON_ISSUE_URL: issue.url ?? "",
    BATON_ISSUE_STATUS: issue.state,
    BATON_WORKSPACE: workspacePath,
  };
}

export async function setupWorkspace(
  issue: Issue,
  config: ReviewConfig,
  logger: Logger,
): Promise<string> {
  const root = path.resolve(expandTilde(config.workspace.root));
  const key = sanitizeWorkspaceKey(issue.identifier);
  const workspacePath = path.resolve(root, key);

  if (workspacePath === root || !workspacePath.startsWith(root + path.sep)) {
    throw new Error(
      `workspace path for ${issue.identifier} escapes workspace root`,
    );
  }

  let exists = false;
  try {
    exists = (await stat(workspacePath)).isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    await mkdir(workspacePath, { recursive: true });

    if (config.hooks.afterCreate) {
      logger.info("running after_create hook", { workspace: workspacePath });
      const result = await runHookScript(config.hooks.afterCreate, {
        cwd: workspacePath,
        env: hookEnv(issue, workspacePath),
        timeoutMs: config.workspace.hookTimeoutMs,
      });
      if (!result.ok) {
        try {
          await rm(workspacePath, { recursive: true, force: true });
        } catch (err) {
          throw new Error(
            `after_create hook failed and workspace cleanup failed: ${String(err)}`,
          );
        }
        throw new Error(
          `after_create hook failed (timedOut=${result.timedOut} code=${result.code}): ${result.output.slice(0, 500)}`,
        );
      }
    }
  }

  if (config.hooks.beforeRun) {
    logger.info("running before_run hook", { workspace: workspacePath });
    const result = await runHookScript(config.hooks.beforeRun, {
      cwd: workspacePath,
      env: hookEnv(issue, workspacePath),
      timeoutMs: config.workspace.hookTimeoutMs,
    });
    if (!result.ok) {
      throw new Error(
        `before_run hook failed (timedOut=${result.timedOut} code=${result.code}): ${result.output.slice(0, 500)}`,
      );
    }
  }

  return workspacePath;
}
