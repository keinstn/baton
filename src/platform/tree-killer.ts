import { type ChildProcess, spawn } from "node:child_process";
import { Logger } from "../observability/logger.js";

/**
 * Grace period to wait for a child `close` after a forced tree kill before
 * force-settling. On Unix `close` follows SIGKILL effectively immediately, so
 * the grace is never reached; on Windows it can lag seconds after taskkill.
 */
const CLOSE_GRACE_MS = 1000;

/** `taskkill` exit code when the target PID no longer exists. The tree is
 *  already gone, so this is a benign race rather than a kill failure. */
const TASKKILL_PID_NOT_FOUND = 128;

/**
 * Per-OS process-tree termination — the one process primitive whose correct
 * implementation genuinely differs by platform. Agents and hooks are spawned in
 * their own process group (`detached: true`); the killer is injected at the
 * composition root so call sites (process.ts, hooks.ts) stay platform-free
 * instead of branching on `process.platform` inline.
 */
export interface TreeKiller {
  /** ms to wait for the child `close` after kill() before force-settling. */
  readonly closeGraceMs: number;
  /**
   * Kill the whole process tree. Resolves once the kill has been issued (Unix)
   * or taskkill has exited (Windows). Best-effort: on failure it falls back to a
   * single-process SIGKILL on `proc`.
   */
  kill(proc: ChildProcess): Promise<void>;
}

/** Unix: signal the whole process group via a negative PID (POSIX-only; relies
 *  on `detached: true` at spawn so the child leads its own group). */
class UnixTreeKiller implements TreeKiller {
  readonly closeGraceMs = CLOSE_GRACE_MS;

  async kill(proc: ChildProcess): Promise<void> {
    const pid = proc.pid;
    if (pid === undefined) {
      proc.kill("SIGKILL");
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Not a group leader (or already gone): fall back to a single kill.
      proc.kill("SIGKILL");
    }
  }
}

/** Windows: `process.kill(-pid)` is a no-op, so reach the bash wrapper's
 *  children (the real `claude.exe` / `copilot.exe`) via `taskkill /T`. */
class WindowsTreeKiller implements TreeKiller {
  readonly closeGraceMs = CLOSE_GRACE_MS;

  constructor(
    private readonly logger = new Logger({ component: "tree-killer" }),
  ) {}

  kill(proc: ChildProcess): Promise<void> {
    const pid = proc.pid;
    if (pid === undefined) {
      proc.kill("SIGKILL");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      tk.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const fallback = () => proc.kill("SIGKILL");
      tk.on("error", (err) => {
        // taskkill could not even be spawned: the tree is untouched, and the
        // single-process fallback cannot reach descendants on Windows. Surface
        // it so a leaked agent/hook tree is not hidden behind a clean shutdown.
        this.warnLeak(pid, { error: err.message });
        fallback();
        resolve();
      });
      tk.on("close", (code) => {
        if (code !== 0) {
          fallback();
          // Exit 128 means the PID was already gone (benign race). Any other
          // non-zero means taskkill genuinely failed; the wrapper-only fallback
          // cannot kill the tree on Windows, so descendants may still be running
          // even though the caller force-settles and reports a clean shutdown.
          if (code !== TASKKILL_PID_NOT_FOUND) {
            this.warnLeak(pid, {
              taskkill_exit: code,
              taskkill_stderr: stderr.trim(),
            });
          }
        }
        resolve();
      });
    });
  }

  private warnLeak(pid: number, fields: Record<string, unknown>): void {
    this.logger.warn(
      "tree kill failed; agent/hook descendants may still be running",
      { pid, ...fields },
    );
  }
}

/** Select the process-tree killer for the current platform. */
export function makeTreeKiller(
  platform = process.platform,
  logger?: Logger,
): TreeKiller {
  return platform === "win32"
    ? new WindowsTreeKiller(logger)
    : new UnixTreeKiller();
}
