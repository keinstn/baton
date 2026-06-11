import type { AgentEventCallback, AgentRunner } from "../agent/runner.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { renderPrompt } from "../prompt/builder.js";
import type { Issue } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { RunWorker } from "./orchestrator.js";

export interface WorkerDeps {
  workspaces: WorkspaceManager;
  runner: AgentRunner;
  /** Getter so Phase 2 hot reload swaps the template for future runs. */
  promptTemplate: () => string;
  logger: Logger;
}

/**
 * Worker attempt (SPEC §16.5, Phase 1: single turn per session).
 * workspace → before_run → render prompt → agent turn → after_run.
 */
export function createWorker(deps: WorkerDeps): RunWorker {
  return async function runWorker(
    issue: Issue,
    attempt: number | null,
    onEvent: AgentEventCallback,
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

    await deps.workspaces.runBeforeRun(issue, workspace.path);

    let prompt: string;
    try {
      prompt = await renderPrompt(deps.promptTemplate(), issue, attempt);
    } catch (err) {
      await deps.workspaces.runAfterRun(issue, workspace.path);
      throw err;
    }

    const session = await deps.runner.startSession(workspace.path);
    try {
      const result = await deps.runner.runTurn(session, prompt, onEvent);
      if (!result.ok) {
        throw new BatonError(
          "turn_failed",
          result.error ?? "agent turn failed",
        );
      }
      log.info("agent turn completed", {
        session_id: session.agentSessionId ?? "",
      });
    } finally {
      await deps.runner.stopSession(session);
      await deps.workspaces.runAfterRun(issue, workspace.path);
    }
  };
}
