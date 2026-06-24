import { spawn } from "node:child_process";
import { makeTreeKiller } from "../../src/platform/tree-killer.js";

export type RunOnceOpts = { timeoutMs?: number; cwd?: string };

/**
 * Spawn `bash -lc <command>`, write optional stdin, collect all stdout,
 * and kill the process on timeout. Rejects if the process exits non-zero
 * or if the timeout fires.
 */
export function runOnce(
  command: string,
  stdin?: string,
  opts?: RunOnceOpts,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const useStdin = stdin !== undefined;
    const proc = spawn("bash", ["-lc", command], {
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });

    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    let resolved = false;
    const treeKiller = makeTreeKiller();

    const timer = setTimeout(() => {
      resolved = true;
      void treeKiller.kill(proc);
      reject(new Error(`subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (useStdin && proc.stdin) {
      proc.stdin.on("error", () => {});
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    proc.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        resolve(output);
      } else {
        const stderrInfo = stderrTail
          ? `\nstderr: ${stderrTail.slice(0, 500)}`
          : "";
        reject(
          new Error(
            `subprocess exited with code ${String(code)}: ${output.slice(0, 500)}${stderrInfo}`,
          ),
        );
      }
    });
  });
}
