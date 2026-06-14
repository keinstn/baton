import { spawn } from "node:child_process";
import { makeTreeKiller, type TreeKiller } from "../agent/tree-killer.js";

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr, truncated (SPEC §15.4). */
  output: string;
}

const MAX_OUTPUT_BYTES = 8 * 1024;

/**
 * Run a workspace hook script (SPEC §9.4): `bash -lc <script>` with the
 * workspace directory as cwd, a hard timeout, and truncated output capture.
 * Spawned detached so a timeout kills the hook's whole process tree (e.g. a
 * `git clone` child), not just the bash wrapper.
 */
export function runHookScript(
  script: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    treeKiller?: TreeKiller;
  },
): Promise<HookResult> {
  return new Promise((resolvePromise) => {
    const treeKiller = opts.treeKiller ?? makeTreeKiller();
    const proc = spawn("bash", ["-lc", script], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    let timedOut = false;
    let resolved = false;
    let graceTimer: NodeJS.Timeout | null = null;
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
      if (graceTimer) clearTimeout(graceTimer);
      if (resolved) return;
      resolved = true;
      resolvePromise({ ...result, output: result.output.trim() });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void treeKiller.kill(proc);
      // Windows can delay or miss the child `close` after a forced tree kill, so
      // force-settle the timeout after the grace period — otherwise the hook
      // (and its caller) would hang. On Unix `close` is immediate and clears
      // this timer first.
      graceTimer = setTimeout(() => {
        proc.stdout.destroy();
        proc.stderr.destroy();
        proc.unref();
        resolveOnce({ ok: false, code: null, timedOut: true, output });
      }, treeKiller.closeGraceMs);
    }, opts.timeoutMs);

    proc.on("error", () => {
      resolveOnce({ ok: false, code: null, timedOut, output });
    });
    proc.on("close", (code) => {
      resolveOnce({ ok: !timedOut && code === 0, code, timedOut, output });
    });
  });
}
