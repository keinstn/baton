import type { Issue } from "../../src/tracker/types.js";
import { isRecord } from "../../src/util.js";
import type { EvaluatorConfig } from "./config.js";
import type { Evaluator, IssueDecision } from "./evaluator.js";
import { renderPrompt } from "./evaluator.js";
import { runOnce } from "./subprocess.js";

function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

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

function parseDecisions(text: string): IssueDecision[] {
  const clean = stripCodeFence(text);
  const parsed: unknown = JSON.parse(clean);
  if (!Array.isArray(parsed)) {
    throw new Error("claude eval: expected JSON array of IssueDecision");
  }
  return parsed as IssueDecision[];
}

export function createClaudeEvaluator(config: EvaluatorConfig): Evaluator {
  return {
    async evaluate(
      issues: Issue[],
      promptTemplate: string,
      repository: string,
    ): Promise<IssueDecision[]> {
      const prompt = await renderPrompt(promptTemplate, issues, repository);

      let command = `${config.command} -p --output-format stream-json --permission-mode bypassPermissions`;
      if (config.model) {
        command += ` --model ${config.model}`;
      }

      const stdout = await runOnce(command, prompt, config.timeoutMs);
      const resultText = extractResult(stdout);
      return parseDecisions(resultText);
    },
  };
}
