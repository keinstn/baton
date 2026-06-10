/** Normalized state/label comparison per SPEC §4.2: trim + lowercase. */
export function norm(s: string): string {
  return s.trim().toLowerCase();
}
