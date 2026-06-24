import { randomUUID } from "node:crypto";
import type { Issue } from "../../src/tracker/types.js";
import { isRecord, shellQuote } from "../../src/util.js";
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

function parseDecisions(text: string): IssueDecision[] {
  const clean = stripCodeFence(text);
  const parsed: unknown = JSON.parse(clean);
  if (!Array.isArray(parsed)) {
    throw new Error("copilot eval: expected JSON array of IssueDecision");
  }
  return parsed as IssueDecision[];
}

export function createCopilotEvaluator(config: EvaluatorConfig): Evaluator {
  return {
    async evaluate(
      issues: Issue[],
      promptTemplate: string,
      repository: string,
    ): Promise<IssueDecision[]> {
      const prompt = await renderPrompt(promptTemplate, issues, repository);
      const sessionId = randomUUID();

      const command = `${config.command} -p ${shellQuote(prompt)} --output-format json --no-ask-user --session-id ${sessionId}`;

      const stdout = await runOnce(command, undefined, config.timeoutMs);
      const content = extractContent(stdout);
      return parseDecisions(content);
    },
  };
}
