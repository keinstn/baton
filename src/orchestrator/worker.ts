import type { AgentEventCallback, AgentRunner } from "../agent/runner.js";
import type { BatonConfig } from "../config/schema.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { continuationGuidance, renderPrompt } from "../prompt/builder.js";
import type { Issue } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { isIssueActive, type RunWorker } from "./orchestrator.js";

export interface WorkerDeps {
  workspaces: WorkspaceManager;
  runner: AgentRunner;
  /** Minimal state refresh between continuation turns (SPEC §11.1 op 3). */
  tracker: { fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> };
  /** Getter so Phase 2 hot reload swaps config (max_turns etc.) for future runs. */
  config: () => BatonConfig;
  /** Getter so Phase 2 hot reload swaps the template for future runs. */
  promptTemplate: () => string;
  logger: Logger;
}

/**
 * Worker attempt (SPEC §16). One agent session per attempt, looping turns until
 * the issue leaves its active set, `agent.max_turns` is reached, or the run is
 * cancelled (stall/reconciliation). The first turn uses the rendered task
 * prompt; continuation turns resume the session with short guidance only.
 *
 * workspace → render prompt → before_run → start session → [turn → refresh]* → after_run.
 */
export function createWorker(deps: WorkerDeps): RunWorker {
  return async function runWorker(
    issue: Issue,
    attempt: number | null,
    onEvent: AgentEventCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const log = deps.logger.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });

    const workspace = await deps.workspaces.createForIssue(issue);
    log.info("workspace ready", {
      workspace: workspace.path,
      created_now: workspace.createdNow,
    });

    // SPEC §7.2: render before before_run so a template error fails the attempt
    // without side-effects from hook execution.
    const firstPrompt = await renderPrompt(
      deps.promptTemplate(),
      issue,
      attempt,
    );

    await deps.workspaces.runBeforeRun(issue, workspace.path);

    const session = await deps.runner.startSession(workspace.path);
    // When the orchestrator cancels (stall/reconciliation) it stops the session;
    // the in-flight turn then ends and the loop breaks (SPEC §8.5).
    const onAbort = () => {
      void deps.runner.stopSession(session);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let current = issue;
    let turn = 1;
    try {
      for (;;) {
        if (signal?.aborted) break; // cancelled before this turn could start

        const prompt =
          turn === 1 ? firstPrompt : continuationGuidance(current, turn);

        const result = await deps.runner.runTurn(session, prompt, onEvent);
        if (!result.ok) {
          throw new BatonError(
            "turn_failed",
            result.error ?? "agent turn failed",
          );
        }
        log.info("agent turn completed", {
          turn,
          session_id: session.agentSessionId ?? "",
        });

        if (signal?.aborted) break; // orchestrator owns the stop decision

        const config = deps.config();
        if (turn >= config.agent.maxTurns) break;

        // Re-check the tracker before deciding to continue (SPEC §16, §11.1 op 3).
        let refreshed: Issue[];
        try {
          refreshed = await deps.tracker.fetchIssueStatesByIds([current.id]);
        } catch (err) {
          throw new BatonError(
            "issue_state_refresh_failed",
            `continuation state refresh failed: ${String(err)}`,
          );
        }
        current = refreshed[0] ?? current;
        if (!isIssueActive(current, config)) {
          log.info("issue left active set; ending session", {
            state: current.state,
            turns: turn,
          });
          break;
        }
        turn += 1;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await deps.runner.stopSession(session);
      await deps.workspaces.runAfterRun(issue, workspace.path);
    }
  };
}
