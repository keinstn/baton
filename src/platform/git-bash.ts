import { existsSync } from "node:fs";

const GIT_BASH_DIRS = [
  "C:\\Program Files\\Git\\bin",
  "C:\\Program Files (x86)\\Git\\bin",
] as const;

interface EnsureGitBashPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
}

function normalizeWindowsPathEntry(entry: string): string {
  const trimmed = entry.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  const withoutTrailingSlashes = unquoted.replace(/[\\/]+$/g, "");
  return withoutTrailingSlashes.toLowerCase();
}

/** Prefer Git Bash over WSL bash for subprocesses that pass Git-Bash-style paths. */
export function ensureGitBashOnWindowsPath(
  options: EnsureGitBashPathOptions = {},
): void {
  const {
    env = process.env,
    platform = process.platform,
    fileExists = existsSync,
  } = options;
  if (platform !== "win32") return;

  const dir = GIT_BASH_DIRS.find((d) => fileExists(`${d}\\bash.exe`));
  if (!dir) return;

  const currentPath = env.PATH ?? "";
  const normalizedDir = normalizeWindowsPathEntry(dir);
  const entries = currentPath === "" ? [] : currentPath.split(";");
  if (entries[0] && normalizeWindowsPathEntry(entries[0]) === normalizedDir) {
    return;
  }

  // Keep Git Bash at PATH head so `spawn("bash")` resolves to it on Windows.
  const withoutGitBash = entries.filter(
    (entry) => normalizeWindowsPathEntry(entry) !== normalizedDir,
  );
  env.PATH = [dir, ...withoutGitBash].join(";");
}
