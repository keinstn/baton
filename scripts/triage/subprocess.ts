import { spawn } from "node:child_process";

/**
 * Spawn `bash -lc <command>`, write optional stdin, collect all stdout,
 * and kill the process on timeout. Rejects if the process exits non-zero
 * or if the timeout fires.
 */
export function runOnce(
  command: string,
  stdin?: string,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const useStdin = stdin !== undefined;
    const proc = spawn("bash", ["-lc", command], {
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });

    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    let resolved = false;

    const timer = setTimeout(() => {
      resolved = true;
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // process.kill(-pid) fails on Windows (negative PIDs unsupported) —
          // best-effort direct kill so the child is not left running after timeout
          proc.kill("SIGKILL");
        }
      } else {
        proc.kill("SIGKILL");
      }
      reject(new Error(`triage subprocess timed out after ${timeoutMs}ms`));
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
            `triage subprocess exited with code ${String(code)}: ${output.slice(0, 500)}${stderrInfo}`,
          ),
        );
      }
    });
  });
}
