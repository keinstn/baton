import { isRecord, shellQuote } from "../../src/util.js";
import { runOnce } from "../lib/subprocess.js";
import type { EvaluatorConfig } from "./config.js";
import type { Evaluator, IssueDecision } from "./evaluator.js";
import { renderPrompt } from "./evaluator.js";
import type { TriageIssue } from "./fetcher.js";
import { parseDecisions } from "./parse.js";

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
    if (isRecord(msg) && msg.type === "result") {
      if (msg.is_error === true) {
        throw new Error(
          `claude returned an error: ${typeof msg.result === "string" ? msg.result : "(no message)"}`,
        );
      }
      if (typeof msg.result === "string") {
        return msg.result as string;
      }
    }
  }
  throw new Error(
    `claude stream-json output contained no {"type":"result"} line`,
  );
}

export function createClaudeEvaluator(config: EvaluatorConfig): Evaluator {
  return {
    async evaluate(
      issues: TriageIssue[],
      promptTemplate: string,
      repository: string,
    ): Promise<IssueDecision[]> {
      const prompt = await renderPrompt(promptTemplate, issues, repository);

      const permissionMode = config.permissionMode;
      const denyTools = config.denyTools ?? ["*"]; // deny-all by default; triage must opt in explicitly to avoid unintended tool access
      let command = `${config.command} -p --output-format stream-json --permission-mode ${shellQuote(permissionMode)} --disallowedTools ${shellQuote(denyTools.join(","))}`;
      if (config.model) {
        command += ` --model ${shellQuote(config.model)}`;
      }

      const stdout = await runOnce(command, prompt, {
        timeoutMs: config.timeoutMs,
      });
      const resultText = extractResult(stdout);
      return parseDecisions(resultText);
    },
  };
}
