/** Normalized state/label comparison per SPEC §4.2: trim + lowercase. */
export function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Current time as an ISO-8601 timestamp; used for normalized event timestamps. */
export function now(): string {
  return new Date().toISOString();
}
