import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeCommandForBash, toBashPath } from "../util.js";
import { makeTreeKiller, type TreeKiller } from "./tree-killer.js";

/**
 * The OS boundary. Every operation Baton performs differently per platform
 * lives behind this port, so business modules (process.ts, manager.ts, the
 * adapters) never branch on `process.platform` — they consume an injected
 * `Platform`. The single OS decision happens in `makePlatform`.
 */
export interface Platform {
  /** Terminate a spawned process tree (SPEC §10.3). */
  readonly treeKiller: TreeKiller;
  /** Convert a native path to the form `bash -lc` expects (Git Bash on Windows). */
  toBashPath(p: string): string;
  /** Make a configured executable path runnable via bash; no-op off Windows. */
  normalizeCommand(command: string): string;
  /** The native-form path when it differs from {@link toBashPath} (Windows),
   *  else null — lets hooks expose a native path only where it is meaningful. */
  nativePath(p: string): string | null;
  /** Remove a directory tree, tolerating transient Windows file locks. */
  removeDir(path: string): Promise<void>;
}

class PosixPlatform implements Platform {
  readonly treeKiller = makeTreeKiller("linux");
  toBashPath = (p: string): string => p;
  normalizeCommand = (command: string): string => command;
  nativePath = (_p: string): string | null => null;
  removeDir = (path: string): Promise<void> =>
    rm(path, { recursive: true, force: true });
}

class WindowsPlatform implements Platform {
  readonly treeKiller = makeTreeKiller("win32");
  toBashPath = (p: string): string => toBashPath(p, "win32");
  normalizeCommand = (command: string): string =>
    normalizeCommandForBash(command, "win32");
  nativePath = (p: string): string | null => p;
  removeDir = (path: string): Promise<void> => removeDirWithRetry(path);
}

/** Select the platform implementation for the current OS. */
export function makePlatform(platform = process.platform): Platform {
  return platform === "win32" ? new WindowsPlatform() : new PosixPlatform();
}

const RM_RETRY_MS = 100;
const RM_RETRY_WINDOW_MS = 5000;

/** Windows holds file handles (antivirus, Search indexer, lagging child exits)
 *  briefly after a process dies, so `rm` can fail transiently; retry within a
 *  bounded window before giving up. */
async function removeDirWithRetry(dirPath: string): Promise<void> {
  const deadline = Date.now() + RM_RETRY_WINDOW_MS;
  for (;;) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isTransientRmError(err) || Date.now() >= deadline) throw err;
      await delay(RM_RETRY_MS);
    }
  }
}

function isTransientRmError(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  const code = err.code;
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "ENOTEMPTY" ||
    code === "UNKNOWN"
  );
}
