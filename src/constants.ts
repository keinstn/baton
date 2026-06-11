/**
 * Shared numeric limits. Centralized so the agent adapters and workspace hooks
 * stay consistent when truncating untrusted subprocess output.
 */

/** Bytes of stderr retained as a rolling tail while a subprocess runs. */
export const STDERR_TAIL_BYTES = 2000;

/** Max bytes of an error message surfaced from a failed turn. */
export const ERROR_MESSAGE_MAX_BYTES = 500;

/** Max bytes of free-form text echoed into notification/malformed events. */
export const DISPLAY_TEXT_MAX_BYTES = 200;
