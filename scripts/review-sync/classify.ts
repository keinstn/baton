import { norm } from "../../src/util.js";

export type ItemDecision =
  | { action: "skip"; reason: "no_open_prs" | "no_threads" }
  | { action: "move"; targetState: string }
  | { action: "noop" };

/**
 * Pure classification of what to do with a project item given the thread
 * statuses of its linked open PRs.  Exported for unit testing.
 */
export function classifyItem(
  openPRThreads: Array<{ hasThreads: boolean; allResolved: boolean }>,
  currentState: string,
  inProgressState: string,
  inReviewState: string,
): ItemDecision {
  if (openPRThreads.length === 0) {
    return { action: "skip", reason: "no_open_prs" };
  }

  let anyUnresolved = false;
  let anyThreads = false;

  for (const { hasThreads, allResolved } of openPRThreads) {
    if (hasThreads) {
      anyThreads = true;
      if (!allResolved) {
        anyUnresolved = true;
        break;
      }
    }
  }

  if (!anyThreads) {
    return { action: "skip", reason: "no_threads" };
  }

  const targetState = anyUnresolved ? inProgressState : inReviewState;

  if (norm(currentState) === norm(targetState)) {
    return { action: "noop" };
  }

  return { action: "move", targetState };
}
