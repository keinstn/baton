import type { Issue } from "../../src/tracker/types.js";
import { isRecord, shellQuote } from "../../src/util.js";
import type { EvaluatorConfig } from "./config.js";
import type { Evaluator, IssueDecision } from "./evaluator.js";
import { renderPrompt } from "./evaluator.js";
import { parseDecisions } from "./parse.js";
import { runOnce } from "./subprocess.js";

function extractResult(stdout: string): string {
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
      msg.type === "result" &&
      typeof msg.result === "string"
    ) {
      return msg.result as string;
    }
  }
  throw new Error(
    `claude stream-json output contained no {"type":"result"} line`,
  );
}

export function createClaudeEvaluator(config: EvaluatorConfig): Evaluator {
  return {
    async evaluate(
      issues: Issue[],
      promptTemplate: string,
      repository: string,
    ): Promise<IssueDecision[]> {
      const prompt = await renderPrompt(promptTemplate, issues, repository);

      const permissionMode = config.permissionMode ?? "bypassPermissions";
      const denyTools = config.denyTools ?? ["*"];
      let command = `${config.command} -p --output-format stream-json --permission-mode ${shellQuote(permissionMode)} --disallowedTools ${shellQuote(denyTools.join(","))}`;
      if (config.model) {
        command += ` --model ${shellQuote(config.model)}`;
      }

      const stdout = await runOnce(command, prompt, config.timeoutMs);
      const resultText = extractResult(stdout);
      return parseDecisions(resultText);
    },
  };
}
