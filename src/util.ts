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

/** Quote a string for safe interpolation into a bash -lc command line. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * `agent.*.command` is a shell string, so Baton must not rewrite arbitrary
 * commands. On Windows we only normalize the documented simple case: a bare or
 * quoted native absolute executable path, so it becomes runnable via Git Bash.
 */
export function normalizeCommandForBash(
  command: string,
  platform = process.platform,
): string {
  if (platform !== "win32") return command;
  const trimmed = command.trim();
  if (trimmed === "") return command;

  const quoted =
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
  const candidate = quoted ? trimmed.slice(1, -1) : trimmed;
  if (!/^[A-Za-z]:[\\/]/.test(candidate)) return command;
  if (!quoted && /\s/.test(candidate)) return command;
  return shellQuote(toBashPath(candidate, platform));
}

/** Current time as an ISO-8601 timestamp; used for normalized event timestamps. */
export function now(): string {
  return new Date().toISOString();
}

/** Type guard for a non-null plain object, e.g. a parsed JSON/GraphQL payload. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
