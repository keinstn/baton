import type { BatonConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { Issue } from "../tracker/types.js";

export interface StartupCleanupDeps {
  tracker: { fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> };
  cleanupWorkspace: (issue: Issue) => Promise<void>;
  config: () => BatonConfig;
  logger: Logger;
}

/**
 * Startup terminal workspace cleanup (SPEC §8.6). Query the issues currently in
 * a terminal state and remove their per-issue workspaces. A fetch failure is
 * logged and tolerated — startup continues — and a per-issue cleanup failure
 * never aborts the sweep.
 */
export async function startupTerminalCleanup(
  deps: StartupCleanupDeps,
): Promise<void> {
  const terminalStates = deps.config().tracker.terminalStates;
  if (terminalStates.length === 0) return;

  let issues: Issue[];
  try {
    issues = await deps.tracker.fetchIssuesByStates(terminalStates);
  } catch (err) {
    deps.logger.error("startup cleanup fetch failed; continuing", {
      error: String(err),
    });
    return;
  }

  let removed = 0;
  for (const issue of issues) {
    try {
      await deps.cleanupWorkspace(issue);
      removed += 1;
    } catch (err) {
      deps.logger.warn("startup cleanup failed for issue; continuing", {
        issue_identifier: issue.identifier,
        error: String(err),
      });
    }
  }
  deps.logger.info("startup terminal workspace cleanup complete", {
    terminal_issues: issues.length,
    removed,
  });
}
