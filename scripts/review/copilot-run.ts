import { randomUUID } from "node:crypto";
import { shellQuote } from "../../src/util.js";
import { runOnce } from "../lib/subprocess.js";
import type { ReviewConfig } from "./config.js";
import type { ReviewRunner } from "./runner.js";

function checkCopilotResult(stdout: string): void {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof msg === "object" &&
      msg !== null &&
      "type" in msg &&
      msg.type === "result"
    ) {
      const exitCode =
        "exitCode" in msg && typeof msg.exitCode === "number"
          ? msg.exitCode
          : 1;
      if (exitCode !== 0) {
        throw new Error(`copilot returned a non-zero exitCode: ${exitCode}`);
      }
      return;
    }
  }
  throw new Error(`copilot json output contained no {"type":"result"} line`);
}

export function createCopilotReviewRunner(config: ReviewConfig): ReviewRunner {
  return {
    async run(workspaceDir: string, prompt: string): Promise<void> {
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > 128 * 1024) {
        throw new Error(
          `copilot review: prompt too large for argv (${promptBytes} bytes > 131072)`,
        );
      }

      const sessionId = randomUUID();
      const { allowAllTools, allowTools, denyTools } = config.copilot;

      let command = `copilot -p ${shellQuote(prompt)} --output-format json --no-ask-user --log-level none --session-id ${sessionId}`;
      if (config.agent.model) {
        command += ` --model ${shellQuote(config.agent.model)}`;
      }
      if (allowAllTools) {
        command += " --allow-all-tools";
      } else {
        for (const tool of allowTools) {
          command += ` --allow-tool=${shellQuote(tool)}`;
        }
      }
      for (const tool of denyTools) {
        command += ` --deny-tool=${shellQuote(tool)}`;
      }

      const stdout = await runOnce(command, undefined, {
        timeoutMs: config.agent.timeoutMs,
        cwd: workspaceDir,
      });
      checkCopilotResult(stdout);
    },
  };
}
