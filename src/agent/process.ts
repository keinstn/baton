import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ERROR_MESSAGE_MAX_BYTES, STDERR_TAIL_BYTES } from "../constants.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { now } from "../util.js";
import type { AgentEventCallback, AgentSession, TurnResult } from "./runner.js";

/**
 * Split a command string into argv tokens, honoring single/double quotes so
 * paths with spaces survive (e.g. `node "C:\\Program Files\\x.js"`). This is a
 * minimal tokenizer for the `claude_code.command` / `copilot.command` contract
 * (executable + args); it deliberately does NOT implement shell semantics —
 * no pipes, redirects, globbing, or variable expansion.
 */
export function splitCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (inToken) {
        tokens.push(cur);
        cur = "";
        inToken = false;
      }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

/**
 * Resolve an executable name to a concrete path on Windows, where `spawn`
 * (with shell:false) does not consult PATHEXT and so cannot find bare names
 * like `claude` that are installed as `claude.cmd`/`claude.exe`. On POSIX the
 * name is returned unchanged and Node resolves it via PATH (execvp semantics).
 * Throws `agent_not_found` when nothing matches.
 */
export function resolveExecutable(name: string): string {
  if (process.platform !== "win32") return name;

  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const hasExt = path.extname(name).length > 0;
  const candidates = (base: string): string[] =>
    hasExt ? [base] : [base, ...pathext.map((ext) => base + ext)];

  // Explicit path (drive-qualified, absolute, or containing a separator).
  if (name.includes("\\") || name.includes("/") || /^[A-Za-z]:/.test(name)) {
    for (const cand of candidates(path.resolve(name))) {
      if (existsSync(cand)) return cand;
    }
    throw new BatonError("agent_not_found", `executable not found: ${name}`);
  }

  // Bare name: search each PATH entry against PATHEXT.
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const cand of candidates(path.join(dir, name))) {
      if (existsSync(cand)) return cand;
    }
  }
  throw new BatonError(
    "agent_not_found",
    `executable not found in PATH: ${name}`,
  );
}

/**
 * Kill a child process and its descendants, cross-platform.
 * - POSIX: signal the process group (negative PID) — relies on spawn with
 *   `detached: true` so the child leads its own group.
 * - Windows: there are no POSIX process groups, so walk the tree with
 *   `taskkill /T /F`.
 */
export function killProcessTree(proc: ChildProcess): void {
  if (proc.pid === undefined) {
    proc.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (res.error) proc.kill();
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
    return;
  } catch {
    // Fall through to single-process kill.
  }
  proc.kill("SIGKILL");
}

/**
 * Compute the spawn target for an argv. On Windows the executable is resolved
 * against PATHEXT; `.cmd`/`.bat` shims require `shell: true` (Node refuses to
 * spawn them otherwise, CVE-2024-27980), while real executables run with
 * `shell: false` so untrusted args never pass through cmd.exe. On POSIX we
 * spawn detached so killProcessTree can signal the whole process group.
 */
function resolveSpawnTarget(argv: string[]): {
  cmd: string;
  args: string[];
  shell: boolean;
  detached: boolean;
} {
  const exe = argv[0];
  if (exe === undefined) {
    throw new BatonError("startup_failed", "empty agent command");
  }
  const args = argv.slice(1);
  if (process.platform !== "win32") {
    return { cmd: exe, args, shell: false, detached: true };
  }
  const resolved = resolveExecutable(exe);
  const ext = path.extname(resolved).toLowerCase();
  return {
    cmd: resolved,
    args,
    shell: ext === ".cmd" || ext === ".bat",
    detached: false,
  };
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
  /** argv to spawn: `argv[0]` is the executable, the rest are arguments. */
  argv: string[];
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
 * Run one agent process: spawn the agent argv directly (no shell wrapper on
 * POSIX or for `.exe` on Windows), stream stdout lines through `onLine`,
 * enforce the turn timeout, and normalize the exit into a TurnResult. Shared by
 * the Claude Code and Copilot adapters (SPEC §10.1, §10.2); only argv
 * construction and line parsing differ.
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
    const { cmd, args, shell, detached } = resolveSpawnTarget(opts.argv);
    // POSIX: detached gives the child its own process group so timeout/stop
    // kills the whole agent tree. Windows: taskkill /T handles the tree, and
    // windowsHide avoids spawning a console window. The stdio tuples are kept
    // as literals so Node's typed overloads give non-null stdout/stderr.
    const proc = useStdin
      ? spawn(cmd, args, {
          cwd: session.workspace,
          stdio: ["pipe", "pipe", "pipe"],
          shell,
          detached,
          windowsHide: true,
        })
      : spawn(cmd, args, {
          cwd: session.workspace,
          stdio: ["ignore", "pipe", "pipe"],
          shell,
          detached,
          windowsHide: true,
        });
    session.proc = proc;

    opts.logger?.debug("subprocess spawned", {
      pid: proc.pid,
      executable: cmd,
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
