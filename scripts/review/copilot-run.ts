import { randomUUID } from "node:crypto";
import { shellQuote } from "../../src/util.js";
import { runOnce } from "../lib/subprocess.js";
import type { ReviewConfig } from "./config.js";
import type { ReviewRunner } from "./runner.js";

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
      const { allowAllTools, allowTools } = config.copilot;

      let command = `copilot -p ${shellQuote(prompt)} --output-format json --no-ask-user --log-level none --session-id ${sessionId}`;
      if (config.agent.model) {
        command += ` --model ${shellQuote(config.agent.model)}`;
      }
      if (allowAllTools) {
        command += ` --allow-tool=*`;
      } else {
        for (const tool of allowTools) {
          command += ` --allow-tool=${shellQuote(tool)}`;
        }
      }

      await runOnce(command, undefined, {
        timeoutMs: config.agent.timeoutMs,
        cwd: workspaceDir,
      });
    },
  };
}
