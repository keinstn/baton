import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { ERROR_MESSAGE_MAX_BYTES, STDERR_TAIL_BYTES } from "../constants.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { now } from "../util.js";
import type { AgentEventCallback, AgentSession, TurnResult } from "./runner.js";

const isWindows = process.platform === "win32";

const cmdShimShebangExpr =
  /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?((?:[^ \t=]+=[^ \t=]+\s+)*)\s*)?([^ \t]+)(.*)$/;

interface ResolvedSubprocessCommand {
  executable: string;
  execArgs: string[];
}

interface ParsedShebang {
  variables: string;
  program: string;
  args: string[];
}

function windowsCommandUnits(parts: readonly string[]): number {
  return parts.join(" ").length;
}

/**
 * Windows command-line limits are based on the final command string length,
 * which is much closer to JS string/code-unit length than UTF-8 byte length.
 */
export function countWindowsCommandUnits(parts: readonly string[]): number {
  return windowsCommandUnits(parts);
}

function splitShellWords(s: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === undefined) continue;
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (current.length > 0) {
          args.push(current);
          current = "";
        }
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current.length > 0) args.push(current);
  return args;
}

function readShebang(firstLine: string): ParsedShebang | null {
  const shebang = firstLine.match(cmdShimShebangExpr);
  if (!shebang) return null;
  const variables = shebang[1] ?? "";
  const program = shebang[2];
  if (program === undefined) return null;
  const rawArgs = (shebang[3] ?? "").trim();
  const args = rawArgs.length === 0 ? [] : splitShellWords(rawArgs);
  if (args === null) return null;
  return { variables, program, args };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function extractCmdShimTarget(content: string): string | null {
  const matches = [...content.matchAll(/"%dp0%\\([^"\r\n]+)"/g)];
  return matches.at(-1)?.[1] ?? null;
}

async function resolveInterpreterProgram(
  program: string,
  shimDir: string,
): Promise<string> {
  const normalized = program.replace(/\//g, sep);
  if (isAbsolute(normalized)) return normalized;
  if (normalized.includes(sep)) return resolve(shimDir, normalized);

  if (/\.(exe|com)$/i.test(normalized)) {
    const localProgram = resolve(shimDir, normalized);
    return (await fileExists(localProgram)) ? localProgram : normalized;
  }

  const localExe = resolve(shimDir, `${normalized}.exe`);
  return (await fileExists(localExe)) ? localExe : normalized;
}

export async function resolveWindowsCmdShim(
  shimPath: string,
  passthroughArgs: readonly string[],
): Promise<ResolvedSubprocessCommand | null> {
  const content = await readFile(shimPath, "utf8");
  const targetRelative = extractCmdShimTarget(content);
  if (!targetRelative) return null;

  const shimDir = dirname(shimPath);
  const targetPath = resolve(shimDir, targetRelative.replace(/\\/g, sep));

  const targetContent = await readFile(targetPath, "utf8").catch(() => null);
  if (targetContent === null) {
    return {
      executable: targetPath,
      execArgs: [...passthroughArgs],
    };
  }

  const firstLine = targetContent.trim().split(/\r?\n/, 1)[0] ?? "";
  const shebang = readShebang(firstLine);
  if (!shebang) {
    return {
      executable: targetPath,
      execArgs: [...passthroughArgs],
    };
  }
  if (shebang.variables.trim() !== "") return null;

  const executable = await resolveInterpreterProgram(shebang.program, shimDir);
  return {
    executable,
    execArgs: [...shebang.args, targetPath, ...passthroughArgs],
  };
}

async function resolveWindowsExecutablePath(
  executable: string,
  cwd: string,
): Promise<string> {
  if (executable.includes("/") || executable.includes("\\")) {
    const candidate = isAbsolute(executable)
      ? executable
      : resolve(cwd, executable);
    return (await fileExists(candidate)) ? candidate : executable;
  }

  if (/\.(cmd|bat|exe|com)$/i.test(executable)) {
    const candidate = resolve(cwd, executable);
    if (await fileExists(candidate)) return candidate;
  }

  const result = spawnSync("where.exe", [executable], {
    encoding: "utf8",
    cwd,
  });
  const stdout = result.stdout ?? "";
  if (result.status !== 0 || !stdout.trim()) return executable;
  return stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? executable;
}

export async function resolveSubprocessCommand(
  command: string | string[],
  cwd: string,
): Promise<ResolvedSubprocessCommand> {
  if (typeof command === "string") {
    return { executable: "bash", execArgs: ["-lc", command] };
  }

  const [first, ...rest] = command;
  if (!first) {
    throw new BatonError("startup_failed", "empty command");
  }
  if (!isWindows) return { executable: first, execArgs: rest };

  const resolvedExecutable = await resolveWindowsExecutablePath(first, cwd);
  if (!/\.(cmd|bat)$/i.test(resolvedExecutable)) {
    return { executable: resolvedExecutable, execArgs: rest };
  }

  const resolvedShim = await resolveWindowsCmdShim(
    resolvedExecutable,
    rest,
  ).catch(() => null);
  if (resolvedShim) return resolvedShim;

  throw new BatonError(
    "startup_failed",
    `unsupported_windows_cmd_shim: ${resolvedExecutable}`,
  );
}

/** Kill the agent's whole process group.
 *  Unix: kills the process group (requires spawn with detached: true).
 *  Windows: uses taskkill /F /T to kill the full process tree. */
export function killProcessTree(proc: ChildProcess): void {
  if (proc.pid !== undefined) {
    if (isWindows) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)]);
      return;
    }
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to single-process kill.
    }
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
  /** Shell command string (spawned via bash -lc) or argv array (spawned directly). */
  command: string | string[];
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
 * Run one agent process, stream stdout lines through `onLine`, enforce the
 * turn timeout, and normalize the exit into a TurnResult. Shared by the
 * Claude Code and Copilot adapters (SPEC §10.1, §10.2); only command
 * construction and line parsing differ.
 *
 * When `command` is a string it is executed via `bash -lc` (backward-
 * compatible shell path). When it is a string[] the executable is spawned
 * directly with no shell wrapper (Windows-native path).
 *
 * The spawned process is stored on `session.proc` so stopSession can terminate
 * it, and cleared once the process closes.
 */
export function runSubprocess(
  session: AgentSession,
  opts: RunSubprocessOptions,
): Promise<TurnResult> {
  return new Promise((resolvePromise) => {
    void (async () => {
      const useStdin = opts.stdin !== undefined;
      let resolvedCommand: ResolvedSubprocessCommand;
      try {
        resolvedCommand = await resolveSubprocessCommand(
          opts.command,
          session.workspace,
        );
      } catch (err) {
        const error =
          err instanceof BatonError
            ? err.message
            : `startup_failed: ${String(err)}`;
        resolvePromise({ ok: false, error });
        return;
      }

      const proc = useStdin
        ? spawn(resolvedCommand.executable, resolvedCommand.execArgs, {
            cwd: session.workspace,
            stdio: ["pipe", "pipe", "pipe"],
            detached: !isWindows,
          })
        : spawn(resolvedCommand.executable, resolvedCommand.execArgs, {
            cwd: session.workspace,
            stdio: ["ignore", "pipe", "pipe"],
            detached: !isWindows,
          });
      session.proc = proc;

      opts.logger?.debug("subprocess spawned", {
        pid: proc.pid,
        ...(typeof opts.command === "string"
          ? { command: opts.command }
          : { executable: resolvedCommand.executable }),
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
    })();
  });
}
