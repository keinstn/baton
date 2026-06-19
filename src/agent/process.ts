import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { ERROR_MESSAGE_MAX_BYTES, STDERR_TAIL_BYTES } from "../constants.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { makeTreeKiller, type TreeKiller } from "../platform/tree-killer.js";
import { now } from "../util.js";
import type { AgentEventCallback, AgentSession, TurnResult } from "./runner.js";

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

/** Create a fresh AgentSession for the given workspace directory. */
export async function createSession(workspace: string): Promise<AgentSession> {
  await ensureWorkspaceDir(workspace);
  return {
    workspace,
    agentSessionId: null,
    proc: null,
    procClosed: null,
    procForceClose: null,
    turnNumber: 0,
  };
}

/** Terminate a session's process tree and wait until it has closed. */
export async function stopSessionProcess(
  session: AgentSession,
  treeKiller: TreeKiller = makeTreeKiller(),
): Promise<void> {
  const proc = session.proc;
  const procClosed = session.procClosed;
  if (!proc) return;
  if (proc.exitCode === null) await treeKiller.kill(proc);
  if (procClosed) {
    // Windows can delay or miss the child `close` after a forced tree kill.
    // Bound the wait, then force-settle the in-flight turn so neither the worker
    // nor this shutdown hangs; procClosed resolves as part of that force-close.
    // On Unix `close` is immediate, so the bounded race resolves at once and the
    // force-close path is never taken.
    const closed = await Promise.race([
      procClosed.then(() => true),
      delay(treeKiller.closeGraceMs).then(() => false),
    ]);
    if (!closed) {
      session.procForceClose?.();
      await procClosed;
    }
  }
  if (session.proc === proc) session.proc = null;
  if (session.procClosed === procClosed) session.procClosed = null;
  session.procForceClose = null;
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
  /** Per-OS process-tree killer; defaults to the current platform's. */
  treeKiller?: TreeKiller;
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
    const treeKiller = opts.treeKiller ?? makeTreeKiller();
    const useStdin = opts.stdin !== undefined;
    // detached: own process group, so timeout/stop kills the whole agent
    // process tree (not just the bash -lc wrapper). The stdio tuples are kept
    // as literals so Node's typed overloads give non-null stdout/stderr.
    const proc = useStdin
      ? spawn("bash", ["-lc", opts.command], {
          cwd: session.workspace,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        })
      : spawn("bash", ["-lc", opts.command], {
          cwd: session.workspace,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        });
    session.proc = proc;
    let resolveProcClosed = () => {};
    session.procClosed = new Promise<void>((resolve) => {
      resolveProcClosed = resolve;
    });
    session.procForceClose = null;

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
      session.procForceClose = null;
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
    const forceCloseProcess = (turnResult: TurnResult) => {
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
      clearResources();
      clearProcessRef();
      if (resolved) return;
      resolved = true;
      resolvePromise(turnResult);
    };
    // The error/close handlers clear the process ref themselves before calling
    // this; the timeout grace path deliberately leaves it intact so stopSession()
    // can await the real close. So resolveOnce only owns timer/rl teardown and the
    // one-shot resolve — never the process ref.
    const resolveOnce = (value: TurnResult, emitTimeoutEvent = false) => {
      clearResources();
      if (resolved) return;
      resolved = true;
      if (emitTimeoutEvent) {
        opts.onEvent({
          event: "turn_cancelled",
          timestamp: now(),
          message: "turn_timeout",
        });
      }
      resolvePromise(value);
    };
    session.procForceClose = () =>
      forceCloseProcess({ ok: false, error: "turn_cancelled" });
    const timer = setTimeout(() => {
      timedOut = true;
      void treeKiller.kill(proc);
      // Windows can delay or miss the child `close` after a forced tree kill, so
      // force-settle the turn after the grace period — otherwise timeout
      // enforcement would hang the worker (and CI). session.proc is left intact
      // (resolveOnce never clears it) so stopSession() can still await the real
      // close when it eventually arrives; the close handler short-circuits on
      // `resolved`. On Unix `close` arrives at once and clears this timer first.
      timeoutGraceTimer = setTimeout(() => {
        resolveOnce({ ok: false, error: "turn_timeout" }, true);
      }, treeKiller.closeGraceMs);
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
        resolveOnce({ ok: false, error: "turn_timeout" }, true);
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
