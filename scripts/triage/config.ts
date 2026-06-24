import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { resolveEnvValue } from "../../src/config/schema.js";

export interface TrackerTriageConfig {
  token: string | null;
  endpoint: string;
  owner: string;
  ownerType: "organization" | "user";
  projectNumber: number;
  statusField: string;
  todoState: string;
  aiReadyLabel: string;
}

export interface EvaluatorConfig {
  kind: "claude_code" | "copilot";
  command: string;
  model: string | null;
  timeoutMs: number;
}

export interface TriageConfig {
  tracker: TrackerTriageConfig;
  evaluator: EvaluatorConfig;
}

type Env = Record<string, string | undefined>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function section(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = raw[key];
  return isRecord(v) ? v : {};
}

function parseFrontMatter(text: string): {
  raw: Record<string, unknown>;
  promptTemplate: string;
} {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { raw: {}, promptTemplate: text.trim() };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }

  if (end === -1) {
    throw new Error("unterminated YAML front matter in TRIAGE.md");
  }

  const frontMatter = lines.slice(1, end).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatter);
  } catch (err) {
    throw new Error(`invalid YAML front matter: ${String(err)}`);
  }

  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (!isRecord(parsed)) {
    throw new Error("YAML front matter must decode to a map");
  }

  return {
    raw: parsed,
    promptTemplate: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

export function parseTriageConfig(
  raw: Record<string, unknown>,
  env: Env = process.env,
): TriageConfig {
  const t = section(raw, "tracker");

  const owner = str(t.owner);
  if (!owner) {
    throw new Error("tracker.owner is required in TRIAGE.md");
  }

  const projectNumberRaw = t.project_number;
  if (
    typeof projectNumberRaw !== "number" ||
    !Number.isInteger(projectNumberRaw) ||
    projectNumberRaw <= 0
  ) {
    throw new Error(
      "tracker.project_number is required and must be a positive integer in TRIAGE.md",
    );
  }

  const tokenRaw = str(t.token) ?? "$GITHUB_TOKEN";
  const tracker: TrackerTriageConfig = {
    token: resolveEnvValue(tokenRaw, env),
    endpoint: str(t.endpoint) ?? "https://api.github.com/graphql",
    owner,
    ownerType: t.owner_type === "user" ? "user" : "organization",
    projectNumber: projectNumberRaw,
    statusField: str(t.status_field) ?? "Status",
    todoState: str(t.todo_state) ?? "Todo",
    aiReadyLabel: str(t.ai_ready_label) ?? "ai-ready",
  };

  const e = section(raw, "evaluator");
  const kind = str(e.kind);
  if (kind !== "claude_code" && kind !== "copilot") {
    throw new Error(
      `evaluator.kind must be "claude_code" or "copilot" in TRIAGE.md, got: ${String(kind)}`,
    );
  }

  const defaultCommand = kind === "claude_code" ? "claude" : "copilot";

  const timeoutMsRaw = e.timeout_ms;
  let timeoutMs = 60000;
  if (timeoutMsRaw !== undefined && timeoutMsRaw !== null) {
    if (
      typeof timeoutMsRaw !== "number" ||
      !Number.isInteger(timeoutMsRaw) ||
      timeoutMsRaw <= 0
    ) {
      throw new Error(
        `evaluator.timeout_ms must be a positive integer, got ${String(timeoutMsRaw)}`,
      );
    }
    timeoutMs = timeoutMsRaw;
  }

  const evaluator: EvaluatorConfig = {
    kind,
    command: str(e.command) ?? defaultCommand,
    model: str(e.model),
    timeoutMs,
  };

  return { tracker, evaluator };
}

export async function loadTriageConfig(
  filePath: string,
  env: Env = process.env,
): Promise<{ config: TriageConfig; promptTemplate: string }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`cannot read triage file: ${filePath}`);
  }

  const { raw, promptTemplate } = parseFrontMatter(text);
  const config = parseTriageConfig(raw, env);

  return { config, promptTemplate };
}
