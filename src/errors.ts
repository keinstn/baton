/**
 * Typed error with a stable machine-readable code.
 *
 * Codes follow the error surfaces defined in docs/SPEC.md:
 * - workflow:  missing_workflow_file, workflow_parse_error, workflow_front_matter_not_a_map
 * - config:    config_invalid
 * - template:  template_parse_error, template_render_error
 * - tracker:   unsupported_tracker_kind, missing_tracker_token, missing_tracker_project,
 *              missing_status_field, github_api_request, github_api_status,
 *              github_graphql_errors, github_unknown_payload, github_missing_end_cursor
 * - workspace: workspace_outside_root, workspace_not_directory, hook_failed
 * - agent:     unsupported_agent_kind, invalid_workspace_cwd, startup_failed, turn_failed,
 *              turn_timeout, process_exit
 */
export class BatonError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BatonError";
  }
}

export function isBatonError(err: unknown, code?: string): err is BatonError {
  return err instanceof BatonError && (code === undefined || err.code === code);
}

/**
 * Extract a string representation of `err.cause` for structured logging.
 * Returns `undefined` when there is no cause, so callers can spread it
 * conditionally: `{ error: String(err), ...errorCause(err) }`.
 */
export function errorCause(err: unknown): { cause: string } | undefined {
  if (err instanceof Error && err.cause != null) {
    return { cause: String(err.cause) };
  }
  return undefined;
}
