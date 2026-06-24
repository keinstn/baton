import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../src/observability/logger.js";
import { makePlatform } from "../../src/platform/platform.js";
import type { Issue } from "../../src/tracker/types.js";
import { runHookScript } from "../../src/workspace/hooks.js";
import { sanitizeWorkspaceKey } from "../../src/workspace/manager.js";
import type { ReviewConfig } from "./config.js";

function hookEnv(
  issue: Issue,
  workspacePath: string,
  platform: ReturnType<typeof makePlatform>,
): Record<string, string> {
  const native = platform.nativePath(workspacePath);
  return {
    BATON_ISSUE_ID: issue.id,
    BATON_ISSUE_IDENTIFIER: issue.identifier,
    BATON_ISSUE_NUMBER: String(issue.number),
    BATON_ISSUE_REPO: issue.repository,
    BATON_ISSUE_URL: issue.url ?? "",
    BATON_ISSUE_STATUS: issue.state,
    BATON_WORKSPACE: platform.toBashPath(workspacePath),
    ...(native ? { BATON_WORKSPACE_NATIVE: native } : {}),
  };
}

export async function setupWorkspace(
  issue: Issue,
  config: ReviewConfig,
  logger: Logger,
): Promise<string> {
  const platform = makePlatform();
  const root = path.resolve(config.workspace.root);
  const key = sanitizeWorkspaceKey(issue.identifier);
  const workspacePath = path.resolve(root, key);

  if (workspacePath === root || !workspacePath.startsWith(root + path.sep)) {
    throw new Error(
      `workspace path for ${issue.identifier} escapes workspace root`,
    );
  }

  let existing: { isDirectory(): boolean } | null = null;
  try {
    existing = await stat(workspacePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
    existing = null;
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new Error(
      `workspace path exists and is not a directory: ${workspacePath}`,
    );
  }
  const exists = existing !== null;

  if (!exists) {
    await mkdir(workspacePath, { recursive: true });

    if (config.hooks.afterCreate) {
      logger.info("running after_create hook", { workspace: workspacePath });
      const result = await runHookScript(config.hooks.afterCreate, {
        cwd: workspacePath,
        env: hookEnv(issue, workspacePath, platform),
        timeoutMs: config.workspace.hookTimeoutMs,
        treeKiller: platform.treeKiller,
      });
      if (!result.ok) {
        logger.error("after_create hook failed", {
          workspace: workspacePath,
          timedOut: result.timedOut,
          code: result.code,
        });
        try {
          await platform.removeDir(workspacePath);
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
      env: hookEnv(issue, workspacePath, platform),
      timeoutMs: config.workspace.hookTimeoutMs,
      treeKiller: platform.treeKiller,
    });
    if (!result.ok) {
      logger.error("before_run hook failed", {
        workspace: workspacePath,
        timedOut: result.timedOut,
        code: result.code,
      });
      throw new Error(
        `before_run hook failed (timedOut=${result.timedOut} code=${result.code}): ${result.output.slice(0, 500)}`,
      );
    }
  }

  return workspacePath;
}
