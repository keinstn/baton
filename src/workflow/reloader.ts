import {
  type BatonConfig,
  buildConfig,
  validateDispatchConfig,
} from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { loadWorkflow } from "./loader.js";

export interface WorkflowState {
  config: BatonConfig;
  promptTemplate: string;
}

/**
 * Dynamic reload of WORKFLOW.md (SPEC §6.2). Holds the last known good config +
 * prompt and exposes them through getters the orchestrator/worker already read.
 * A reload that fails to load, build, or validate keeps the current state and
 * surfaces an operator-visible error instead of crashing the service.
 */
export class WorkflowReloader {
  private current: WorkflowState;
  private reloadInFlight: Promise<boolean> | null = null;
  private reloadPending = false;

  constructor(
    private readonly path: string,
    initial: WorkflowState,
    private readonly logger: Logger,
    /** Applied after a successful reload (e.g. refresh the tracker's project cache). */
    private readonly onApply?: (config: BatonConfig) => void,
  ) {
    this.current = initial;
  }

  config(): BatonConfig {
    return this.current.config;
  }

  promptTemplate(): string {
    return this.current.promptTemplate;
  }

  /**
   * Re-read and re-apply the workflow file. Returns true when the new state was
   * adopted, false when the previous last-known-good state was retained.
   *
   * Concurrent calls are serialised: a second call while one is in flight sets a
   * pending flag so exactly one follow-up reload runs after the current one
   * finishes, preventing a slower stale reload from overwriting a newer result.
   */
  async reload(): Promise<boolean> {
    if (this.reloadInFlight) {
      this.reloadPending = true;
      return false;
    }
    this.reloadInFlight = this._doReload().finally(() => {
      this.reloadInFlight = null;
      if (this.reloadPending) {
        this.reloadPending = false;
        void this.reload();
      }
    });
    return this.reloadInFlight;
  }

  private async _doReload(): Promise<boolean> {
    let workflow: Awaited<ReturnType<typeof loadWorkflow>>;
    try {
      workflow = await loadWorkflow(this.path);
    } catch (err) {
      this.logger.error(
        "workflow reload failed to load; keeping last known good",
        {
          path: this.path,
          error: String(err),
        },
      );
      return false;
    }

    let config: BatonConfig;
    try {
      config = buildConfig(workflow.config, workflow.dir);
    } catch (err) {
      this.logger.error(
        "workflow reload failed to build config; keeping last known good",
        { path: this.path, error: String(err) },
      );
      return false;
    }

    const validation = validateDispatchConfig(config);
    if (!validation.ok) {
      for (const e of validation.errors) {
        this.logger.error(
          "workflow reload validation failed; keeping last known good",
          { code: e.code, detail: e.message },
        );
      }
      return false;
    }

    this.current = { config, promptTemplate: workflow.promptTemplate };
    this.onApply?.(config);
    this.logger.info("workflow reloaded", { path: this.path });
    return true;
  }
}
