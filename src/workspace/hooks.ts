import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { killProcessTree, resolveExecutable } from "../agent/process.js";

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr, truncated (SPEC §15.4). */
  output: string;
}

const MAX_OUTPUT_BYTES = 8 * 1024;

/**
 * Resolve the `bash` used to run hooks. On POSIX this is the PATH `bash`. On
 * Windows hooks are POSIX shell scripts, so a bash is required: PATH is checked
 * first (e.g. Git for Windows on PATH), then the common Git install locations.
 * Returns null when none is found so the caller can surface a clear failure.
 */
function resolveBash(): string | null {
  try {
    return resolveExecutable("bash");
  } catch {
    // Not on PATH; on Windows fall back to known Git for Windows locations.
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      ...(process.env.LOCALAPPDATA
        ? [`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`]
        : []),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * Run a workspace hook script (SPEC §9.4): `bash -lc <script>` with the
 * workspace directory as cwd, a hard timeout, and truncated output capture.
 * On Windows this requires Git for Windows' bash (see resolveBash).
 */
export function runHookScript(
  script: string,
  opts: { cwd: string; env?: Record<string, string>; timeoutMs: number },
): Promise<HookResult> {
  return new Promise((resolvePromise) => {
    const bash = resolveBash();
    if (bash === null) {
      resolvePromise({
        ok: false,
        code: null,
        timedOut: false,
        output:
          "bash not found; install Git for Windows (bash.exe) to run hooks on Windows",
      });
      return;
    }
    // bash(.exe) is a real executable, so spawn it directly (shell: false).
    // POSIX: detached so killProcessTree can signal the whole group on timeout.
    const proc = spawn(bash, ["-lc", script], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) {
        output += chunk
          .toString("utf8")
          .slice(0, MAX_OUTPUT_BYTES - output.length);
      }
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, opts.timeoutMs);

    proc.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, timedOut, output });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: !timedOut && code === 0,
        code,
        timedOut,
        output: output.trim(),
      });
    });
  });
}
