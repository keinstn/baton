import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { resolveEnvValue } from "../../src/config/schema.js";
import { isRecord } from "../../src/util.js";

export interface TrackerTriageConfig {
  token: string | null;
  endpoint: string;
  owner: string;
  ownerType: "organization" | "user";
  projectNumber: number;
  statusField: string;
  todoState: string;
  aiReadyLabel: string;
  repos: string[] | null;
}

export interface EvaluatorConfig {
  kind: "claude_code" | "copilot";
  command: string;
  model: string | null;
  timeoutMs: number;
  permissionMode: string;
  denyTools?: string[];
}

export interface TriageConfig {
  tracker: TrackerTriageConfig;
  evaluator: EvaluatorConfig;
}

type Env = Record<string, string | undefined>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function resolveStr(v: unknown, env: Env): string | null {
  const s = str(v);
  return s === null ? null : resolveEnvValue(s, env);
}

function section(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = raw[key];
  if (v !== undefined && !isRecord(v)) {
    throw new Error(`"${key}" must be a map in TRIAGE.md, got: ${typeof v}`);
  }
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
    throw new Error("unterminated YAML front matter");
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

  const owner = resolveStr(t.owner, env);
  if (!owner) {
    throw new Error("tracker.owner is required in TRIAGE.md");
  }

  const projectNumberRaw = t.project_number;
  let projectNumber: number;
  if (typeof projectNumberRaw === "number") {
    projectNumber = projectNumberRaw;
  } else if (typeof projectNumberRaw === "string") {
    const resolved = resolveEnvValue(projectNumberRaw, env);
    const parsed = resolved !== null ? Number(resolved) : NaN;
    projectNumber = parsed;
  } else {
    projectNumber = NaN;
  }
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(
      "tracker.project_number is required and must be a positive integer in TRIAGE.md",
    );
  }

  const ownerTypeRaw = resolveStr(t.owner_type, env);
  let ownerType: "organization" | "user";
  if (
    ownerTypeRaw === undefined ||
    ownerTypeRaw === null ||
    ownerTypeRaw === ""
  ) {
    ownerType = "organization";
  } else if (ownerTypeRaw === "organization" || ownerTypeRaw === "user") {
    ownerType = ownerTypeRaw;
  } else {
    throw new Error(
      `tracker.owner_type must be "organization" or "user" in TRIAGE.md, got: ${String(ownerTypeRaw)}`,
    );
  }

  const tokenRaw = str(t.token) ?? "$GITHUB_TOKEN"; // literal string passed to resolveEnvValue below, which expands $VAR — same lazy pattern as src/config/schema.ts
  const reposRaw = t.repos;
  const repos: string[] | null =
    Array.isArray(reposRaw) && reposRaw.every((x) => typeof x === "string")
      ? (reposRaw as string[])
      : null;
  const tracker: TrackerTriageConfig = {
    token: resolveEnvValue(tokenRaw, env),
    endpoint: resolveStr(t.endpoint, env) ?? "https://api.github.com/graphql",
    owner,
    ownerType,
    projectNumber,
    statusField: resolveStr(t.status_field, env) ?? "Status",
    todoState: resolveStr(t.todo_state, env) ?? "Todo",
    aiReadyLabel: resolveStr(t.ai_ready_label, env) ?? "ai-ready",
    repos,
  };

  const e = section(raw, "evaluator");
  const kind = resolveStr(e.kind, env);
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

  const permissionModeRaw = resolveStr(e.permission_mode, env);
  const permissionMode = permissionModeRaw ?? "bypassPermissions";

  const denyToolsRaw = e.deny_tools;
  const denyTools: string[] | undefined =
    Array.isArray(denyToolsRaw) &&
    denyToolsRaw.every((x) => typeof x === "string")
      ? (denyToolsRaw as string[])
      : undefined;

  const evaluator: EvaluatorConfig = {
    kind,
    command: resolveStr(e.command, env) ?? defaultCommand,
    model: resolveStr(e.model, env),
    timeoutMs,
    permissionMode,
    denyTools,
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
  } catch (e) {
    throw new Error(`cannot read triage file: ${filePath}`, { cause: e });
  }

  const { raw, promptTemplate } = parseFrontMatter(text);
  const config = parseTriageConfig(raw, env);

  return { config, promptTemplate };
}
