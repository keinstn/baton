import { randomUUID } from "node:crypto";
import type { Issue } from "../../src/tracker/types.js";
import { isRecord, shellQuote } from "../../src/util.js";
import type { EvaluatorConfig } from "./config.js";
import type { Evaluator, IssueDecision } from "./evaluator.js";
import { renderPrompt } from "./evaluator.js";
import { parseDecisions } from "./parse.js";
import { runOnce } from "./subprocess.js";

function extractContent(stdout: string): string {
  const parts: string[] = [];
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
      isRecord(msg) &&
      msg.type === "assistant.message" &&
      isRecord(msg.data) &&
      typeof msg.data.content === "string"
    ) {
      parts.push(msg.data.content as string);
    }
  }
  if (parts.length === 0) {
    throw new Error(
      `copilot output contained no {"type":"assistant.message"} lines`,
    );
  }
  return parts.join("");
}

export function createCopilotEvaluator(config: EvaluatorConfig): Evaluator {
  return {
    async evaluate(
      issues: Issue[],
      promptTemplate: string,
      repository: string,
    ): Promise<IssueDecision[]> {
      const prompt = await renderPrompt(promptTemplate, issues, repository);

      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > 128 * 1024) {
        throw new Error(
          `copilot eval: prompt too large for argv (${promptBytes} bytes > 131072); reduce issue batch size`,
        );
      }

      const sessionId = randomUUID();

      let command = `${config.command} -p ${shellQuote(prompt)} --output-format json --no-ask-user --session-id ${sessionId}`;
      if (config.model) {
        command += ` --model ${shellQuote(config.model)}`;
      }

      const stdout = await runOnce(command, undefined, config.timeoutMs);
      const content = extractContent(stdout);
      return parseDecisions(content);
    },
  };
}
