import { spawn } from "node:child_process";
import { killWindowsTree } from "../agent/process.js";

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr, truncated (SPEC §15.4). */
  output: string;
}

const MAX_OUTPUT_BYTES = 8 * 1024;
const TIMEOUT_KILL_GRACE_MS = 1000;

/**
 * Run a workspace hook script (SPEC §9.4): `bash -lc <script>` with the
 * workspace directory as cwd, a hard timeout, and truncated output capture.
 */
export function runHookScript(
  script: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    platform?: NodeJS.Platform;
    timeoutGraceMs?: number;
  },
): Promise<HookResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn("bash", ["-lc", script], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    let resolved = false;
    let timeoutGraceTimer: NodeJS.Timeout | null = null;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) {
        output += chunk
          .toString("utf8")
          .slice(0, MAX_OUTPUT_BYTES - output.length);
      }
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    const resolveOnce = (result: HookResult) => {
      clearTimeout(timer);
      if (timeoutGraceTimer) clearTimeout(timeoutGraceTimer);
      if (resolved) return;
      resolved = true;
      resolvePromise({ ...result, output: result.output.trim() });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const platform = opts.platform ?? process.platform;
      // Hooks are not spawned detached, so the POSIX process-group kill used for
      // agents is unsafe here; kill the single bash process on Unix, and the
      // whole tree by PID on Windows so hook children are not orphaned.
      if (platform === "win32" && proc.pid !== undefined) {
        killWindowsTree(proc.pid, () => proc.kill("SIGKILL"));
        // Mirror the agent subprocess safeguard: Windows can occasionally miss
        // or delay `close` after taskkill, so force-settle the timeout path.
        timeoutGraceTimer = setTimeout(() => {
          proc.stdout.destroy();
          proc.stderr.destroy();
          proc.unref();
          resolveOnce({ ok: false, code: null, timedOut: true, output });
        }, opts.timeoutGraceMs ?? TIMEOUT_KILL_GRACE_MS);
      } else {
        proc.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    proc.on("error", () => {
      resolveOnce({ ok: false, code: null, timedOut, output });
    });
    proc.on("close", (code) => {
      resolveOnce({
        ok: !timedOut && code === 0,
        code,
        timedOut,
        output,
      });
    });
  });
}
