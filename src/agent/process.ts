import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ERROR_MESSAGE_MAX_BYTES, STDERR_TAIL_BYTES } from "../constants.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { now } from "../util.js";
import type { AgentEventCallback, AgentSession, TurnResult } from "./runner.js";

/** Quote a string for safe interpolation into a bash -lc command line. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Kill a process tree on Windows by PID. `process.kill(-pid)` is a no-op there,
 * so `taskkill /T` is the only way to reach the bash wrapper's children (the
 * real `claude.exe` / `copilot.exe`). Best-effort; spawn errors fall back.
 */
export function killWindowsTree(pid: number, onError: () => void): void {
  spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
  }).on("error", onError);
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

/** Terminate a session's process tree if it is still running. */
export function stopSessionProcess(session: AgentSession): void {
  if (session.proc && session.proc.exitCode === null && !session.proc.killed) {
    killProcessTree(session.proc);
  }
  session.proc = null;
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
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, opts.timeoutMs);

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const r = opts.onLine(line);
      if (r) result = r;
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      session.proc = null;
      opts.logger?.debug("subprocess error", {
        pid: proc.pid,
        error: String(err),
      });
      resolvePromise({ ok: false, error: `startup_failed: ${String(err)}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      session.proc = null;
      opts.logger?.debug("subprocess closed", {
        pid: proc.pid,
        exit_code: code,
        timed_out: timedOut,
        ...(stderrTail.length > 0
          ? { stderr_tail: stderrTail.slice(-200) }
          : {}),
      });
      if (timedOut) {
        opts.onEvent({
          event: "turn_cancelled",
          timestamp: now(),
          message: "turn_timeout",
        });
        resolvePromise({ ok: false, error: "turn_timeout" });
      } else if (result) {
        resolvePromise(result);
      } else {
        const error = `process_exit code=${code} stderr=${stderrTail.slice(-ERROR_MESSAGE_MAX_BYTES)}`;
        opts.onEvent({
          event: "turn_failed",
          timestamp: now(),
          message: error,
        });
        resolvePromise(code === 0 ? { ok: true } : { ok: false, error });
      }
    });
  });
}
