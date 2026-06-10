/** SPEC §8.4: continuation retries after a clean worker exit use a short fixed delay. */
export const CONTINUATION_DELAY_MS = 1000;

/** SPEC §8.4: failure-driven retry backoff `min(10000 * 2^(attempt-1), cap)`. */
export function failureBackoffMs(attempt: number, capMs: number): number {
  const a = Math.max(1, Math.floor(attempt));
  // Cap the exponent before exponentiation to avoid overflow for large attempts.
  const exp = Math.min(a - 1, 30);
  return Math.min(10000 * 2 ** exp, capMs);
}
