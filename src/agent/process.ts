import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { ERROR_MESSAGE_MAX_BYTES, STDERR_TAIL_BYTES } from "../constants.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { now, toBashPath } from "../util.js";
import type { AgentEventCallback, AgentSession, TurnResult } from "./runner.js";

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

/**
 * Kill a process tree on Windows by PID. `process.kill(-pid)` is a no-op there,
 * so `taskkill /T` is the only way to reach the bash wrapper's children (the
 * real `claude.exe` / `copilot.exe`). Best-effort; spawn errors fall back.
 */
export function killWindowsTree(pid: number, onError: () => void): void {
  const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
  });
  tk.on("error", onError);
  // If taskkill exits non-zero the process was not killed; fall back so that
  // proc.on("close") is guaranteed to fire and the runSubprocess Promise resolves.
  tk.on("close", (code) => {
    if (code !== 0) onError();
  });
}

export function killWindowsTreeAndWait(
  pid: number,
  onError: () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
    });
    tk.on("error", () => {
      onError();
      resolve(false);
    });
    tk.on("close", (code) => {
      if (code !== 0) onError();
      resolve(code === 0);
    });
  });
}

/**
 * Kill the agent's whole process tree. On Unix, signal the process group
 * (requires spawn with detached: true); on Windows, `taskkill /T` by PID, since
 * negative-pid signals are POSIX-only and would orphan the agent child.
 */
export function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) {
    proc.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    killWindowsTree(pid, () => proc.kill("SIGKILL"));
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Fall through to single-process kill.
  }
  proc.kill("SIGKILL");
}

/** SPEC §9.5 Invariant 1: validate the workspace cwd before launching an agent. */
export async function ensureWorkspaceDir(workspace: string): Promise<void> {
  let isDir = false;
  try {
    isDir = (await stat(workspace)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new BatonError(
      "invalid_workspace_cwd",
      `not a directory: ${workspace}`,
    );
  }
}

/** Terminate a session's process tree and wait until it has closed. */
export async function stopSessionProcess(session: AgentSession): Promise<void> {
  const proc = session.proc;
  const procClosed = session.procClosed;
  const waitForProcClosed = async (): Promise<void> => {
    if (!procClosed) return;
    if (process.platform !== "win32") {
      await procClosed;
      return;
    }
    // Windows may briefly delay the child `close` after a forced tree kill;
    // bound the wait so shutdown never hangs the worker.
    await Promise.race([procClosed, delay(TIMEOUT_KILL_GRACE_MS)]);
  };
  if (!proc) return;
  if (proc.exitCode !== null) {
    await waitForProcClosed();
  } else if (process.platform === "win32" && proc.pid !== undefined) {
    await killWindowsTreeAndWait(proc.pid, () => proc.kill("SIGKILL"));
    await waitForProcClosed();
  } else {
    killProcessTree(proc);
    if (procClosed) await procClosed;
  }
  if (session.proc === proc) session.proc = null;
  if (session.procClosed === procClosed) session.procClosed = null;
}

export interface RunSubprocessOptions {
  /** Full command line passed to `bash -lc`. */
  command: string;
  /** Per-turn timeout; on expiry the whole process tree is killed (SPEC §10.3). */
  timeoutMs: number;
  /** When set, written to the child's stdin then closed; otherwise stdin is ignored. */
  stdin?: string;
  onEvent: AgentEventCallback;
  /** Parse one stdout line; return a TurnResult once the turn outcome is known. */
  onLine: (line: string) => TurnResult | null;
  /** Optional logger for subprocess lifecycle events (debug level). */
  logger?: Logger;
}

const TIMEOUT_KILL_GRACE_MS = 1000;

/**
 * Run one agent process: spawn `bash -lc <command>` in its own process group,
 * stream stdout lines through `onLine`, enforce the turn timeout, and normalize
 * the exit into a TurnResult. Shared by the Claude Code and Copilot adapters
 * (SPEC §10.1, §10.2); only command construction and line parsing differ.
 *
 * The spawned process is stored on `session.proc` so stopSession can terminate
 * it, and cleared once the process closes.
 */
export function runSubprocess(
  session: AgentSession,
  opts: RunSubprocessOptions,
): Promise<TurnResult> {
  return new Promise((resolvePromise) => {
    const useStdin = opts.stdin !== undefined;
    // detached: own process group, so timeout/stop kills the whole agent
    // process tree (not just the bash -lc wrapper). The stdio tuples are kept
    // as literals so Node's typed overloads give non-null stdout/stderr.
    const proc = useStdin
      ? spawn("bash", ["-lc", opts.command], {
          cwd: session.workspace,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        })
      : spawn("bash", ["-lc", opts.command], {
          cwd: session.workspace,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
    session.proc = proc;
    let resolveProcClosed = () => {};
    session.procClosed = new Promise<void>((resolve) => {
      resolveProcClosed = resolve;
    });

    opts.logger?.debug("subprocess spawned", {
      pid: proc.pid,
      executable: opts.command.split(" ")[0],
      workspace: session.workspace,
    });

    if (useStdin && proc.stdin) {
      proc.stdin.on("error", () => {
        // Process may exit before consuming stdin; close handler reports it.
      });
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }

    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(
        -STDERR_TAIL_BYTES,
      );
    });

    let result: TurnResult | null = null;
    let timedOut = false;
    // Guard against Node.js firing both `error` and `close` on spawn failure
    // (ENOENT etc.). The first handler to resolve wins; the second must not
    // call onEvent again (callbacks are not idempotent).
    let resolved = false;
    let timeoutGraceTimer: NodeJS.Timeout | null = null;
    const clearProcessRef = () => {
      if (session.proc === proc) session.proc = null;
      if (session.procClosed) {
        resolveProcClosed();
        session.procClosed = null;
      }
    };
    const clearResources = () => {
      clearTimeout(timer);
      if (timeoutGraceTimer) clearTimeout(timeoutGraceTimer);
      rl.close();
    };
    const resolveOnce = (
      value: TurnResult,
      resolveOpts: {
        emitTimeoutEvent?: boolean;
        clearProcessRef?: boolean;
      } = {},
    ) => {
      clearResources();
      if (resolved) return;
      resolved = true;
      if (resolveOpts.clearProcessRef !== false) clearProcessRef();
      if (resolveOpts.emitTimeoutEvent) {
        opts.onEvent({
          event: "turn_cancelled",
          timestamp: now(),
          message: "turn_timeout",
        });
      }
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && proc.pid !== undefined) {
        void killWindowsTreeAndWait(proc.pid, () => proc.kill("SIGKILL"));
        // Windows can delay or miss the child `close` after a forced tree kill,
        // so force-settle the turn after a short grace period — otherwise
        // timeout enforcement would hang the worker (and CI). Keep session.proc
        // intact (clearProcessRef: false) so stopSession() can still await the
        // real close when it eventually arrives; the close handler short-circuits
        // on `resolved`.
        timeoutGraceTimer = setTimeout(() => {
          resolveOnce(
            { ok: false, error: "turn_timeout" },
            { emitTimeoutEvent: true, clearProcessRef: false },
          );
        }, TIMEOUT_KILL_GRACE_MS);
      } else {
        // On Unix, `close` arrives promptly after the SIGKILL tree kill.
        killProcessTree(proc);
      }
    }, opts.timeoutMs);

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const r = opts.onLine(line);
      if (r) result = r;
    });

    proc.on("error", (err) => {
      clearResources();
      clearProcessRef();
      if (resolved) return;
      opts.logger?.debug("subprocess error", {
        pid: proc.pid,
        error: String(err),
      });
      resolveOnce({ ok: false, error: `startup_failed: ${String(err)}` });
    });
    proc.on("close", (code) => {
      clearResources();
      clearProcessRef();
      opts.logger?.debug("subprocess closed", {
        pid: proc.pid,
        exit_code: code,
        timed_out: timedOut,
        ...(stderrTail.length > 0
          ? { stderr_tail: stderrTail.slice(-200) }
          : {}),
      });
      if (resolved) return;
      if (timedOut) {
        resolveOnce(
          { ok: false, error: "turn_timeout" },
          { emitTimeoutEvent: true },
        );
      } else if (result) {
        resolveOnce(result);
      } else {
        const error = `process_exit code=${code} stderr=${stderrTail.slice(-ERROR_MESSAGE_MAX_BYTES)}`;
        opts.onEvent({
          event: "turn_failed",
          timestamp: now(),
          message: error,
        });
        resolveOnce(code === 0 ? { ok: true } : { ok: false, error });
      }
    });
  });
}
