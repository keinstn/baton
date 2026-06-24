import { isRecord, shellQuote } from "../../src/util.js";
import { runOnce } from "../lib/subprocess.js";
import type { ReviewConfig } from "./config.js";
import type { ReviewRunner } from "./runner.js";

function checkResult(stdout: string): void {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(msg) && msg.type === "result") {
      if (msg.is_error === true) {
        throw new Error(
          `claude returned an error: ${typeof msg.result === "string" ? msg.result : "(no message)"}`,
        );
      }
      return;
    }
  }
  throw new Error(
    `claude stream-json output contained no {"type":"result"} line`,
  );
}

export function createClaudeReviewRunner(config: ReviewConfig): ReviewRunner {
  return {
    async run(workspaceDir: string, prompt: string): Promise<void> {
      const { permissionMode, denyTools } = config.claudeCode;
      const effectiveDenyTools = denyTools.length > 0 ? denyTools : [];

      let command = `claude -p --output-format stream-json --permission-mode ${shellQuote(permissionMode)}`;
      if (effectiveDenyTools.length > 0) {
        command += ` --disallowedTools ${shellQuote(effectiveDenyTools.join(","))}`;
      }
      if (config.agent.model) {
        command += ` --model ${shellQuote(config.agent.model)}`;
      }

      const stdout = await runOnce(command, prompt, {
        timeoutMs: config.agent.timeoutMs,
        cwd: workspaceDir,
      });
      checkResult(stdout);
    },
  };
}
