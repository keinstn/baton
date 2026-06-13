/** Normalized state/label comparison per SPEC §4.2: trim + lowercase. */
export function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Convert a native Windows absolute path to Git Bash/MSYS form for `bash -lc`. */
export function toBashPath(p: string, platform = process.platform): string {
  if (platform !== "win32") return p;
  return p
    .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
    .replaceAll("\\", "/");
}

/** Current time as an ISO-8601 timestamp; used for normalized event timestamps. */
export function now(): string {
  return new Date().toISOString();
}

/** Type guard for a non-null plain object, e.g. a parsed JSON/GraphQL payload. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
