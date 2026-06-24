import { readFile } from "node:fs/promises";
import { resolveEnvValue } from "../../src/config/schema.js";
import { isRecord, parseFrontMatter } from "../../src/util.js";

export interface ReviewTrackerConfig {
  token: string | null;
  owner: string;
  ownerType: "organization" | "user";
  projectNumber: number;
  statusField: string;
  activeStates: string[];
  repos: string[] | null;
}

export interface WorkspaceConfig {
  root: string;
  hookTimeoutMs: number;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
}

export interface AgentConfig {
  kind: "claude_code" | "copilot";
  timeoutMs: number;
  model: string | null;
  maxConcurrent: number;
}

export interface CopilotConfig {
  allowAllTools: boolean;
  allowTools: string[];
  denyTools: string[];
}

export interface ClaudeCodeConfig {
  permissionMode: string;
  denyTools: string[];
}

export interface ReviewConfig {
  tracker: ReviewTrackerConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  copilot: CopilotConfig;
  claudeCode: ClaudeCodeConfig;
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
    throw new Error(`"${key}" must be a map in REVIEW.md, got: ${typeof v}`);
  }
  return isRecord(v) ? v : {};
}

export function parseReviewConfig(
  raw: Record<string, unknown>,
  env: Env = process.env,
): ReviewConfig {
  const t = section(raw, "tracker");

  const owner = resolveStr(t.owner, env);
  if (!owner) {
    throw new Error("tracker.owner is required in REVIEW.md");
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
      "tracker.project_number is required and must be a positive integer in REVIEW.md",
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
      `tracker.owner_type must be "organization" or "user" in REVIEW.md, got: ${String(ownerTypeRaw)}`,
    );
  }

  const activeStatesRaw = t.active_states;
  const activeStates: string[] =
    Array.isArray(activeStatesRaw) &&
    activeStatesRaw.every((x) => typeof x === "string")
      ? (activeStatesRaw as string[])
      : [];
  if (activeStates.length === 0) {
    throw new Error(
      "tracker.active_states is required and must be a non-empty string array in REVIEW.md",
    );
  }

  const reposRaw = t.repos;
  const repos: string[] | null =
    Array.isArray(reposRaw) && reposRaw.every((x) => typeof x === "string")
      ? (reposRaw as string[])
      : null;

  const tokenRaw = str(t.token) ?? "$GITHUB_TOKEN"; // literal string passed to resolveEnvValue below, which expands $VAR — same lazy pattern as src/config/schema.ts
  const tracker: ReviewTrackerConfig = {
    token: resolveEnvValue(tokenRaw, env),
    owner,
    ownerType,
    projectNumber,
    statusField: resolveStr(t.status_field, env) ?? "Status",
    activeStates,
    repos,
  };

  const w = section(raw, "workspace");
  const rootRaw = resolveStr(w.root, env);
  if (!rootRaw) {
    throw new Error("workspace.root is required in REVIEW.md");
  }
  const hookTimeoutMsRaw = w.hook_timeout_ms;
  let hookTimeoutMs = 120000;
  if (hookTimeoutMsRaw !== undefined && hookTimeoutMsRaw !== null) {
    if (
      typeof hookTimeoutMsRaw !== "number" ||
      !Number.isInteger(hookTimeoutMsRaw) ||
      hookTimeoutMsRaw <= 0
    ) {
      throw new Error(
        `workspace.hook_timeout_ms must be a positive integer, got ${String(hookTimeoutMsRaw)}`,
      );
    }
    hookTimeoutMs = hookTimeoutMsRaw;
  }
  const workspace: WorkspaceConfig = { root: rootRaw, hookTimeoutMs };

  const h = section(raw, "hooks");
  const hooks: HooksConfig = {
    afterCreate: str(h.after_create),
    beforeRun: str(h.before_run),
  };

  const a = section(raw, "agent");
  const kind = resolveStr(a.kind, env);
  if (kind !== "claude_code" && kind !== "copilot") {
    throw new Error(
      `agent.kind must be "claude_code" or "copilot" in REVIEW.md, got: ${String(kind)}`,
    );
  }

  const timeoutMsRaw = a.timeout_ms;
  let timeoutMs = 300000;
  if (timeoutMsRaw !== undefined && timeoutMsRaw !== null) {
    if (
      typeof timeoutMsRaw !== "number" ||
      !Number.isInteger(timeoutMsRaw) ||
      timeoutMsRaw <= 0
    ) {
      throw new Error(
        `agent.timeout_ms must be a positive integer, got ${String(timeoutMsRaw)}`,
      );
    }
    timeoutMs = timeoutMsRaw;
  }

  const maxConcurrentRaw = a.max_concurrent;
  let maxConcurrent = 1;
  if (maxConcurrentRaw !== undefined && maxConcurrentRaw !== null) {
    if (
      typeof maxConcurrentRaw !== "number" ||
      !Number.isInteger(maxConcurrentRaw) ||
      maxConcurrentRaw <= 0
    ) {
      throw new Error(
        `agent.max_concurrent must be a positive integer, got ${String(maxConcurrentRaw)}`,
      );
    }
    maxConcurrent = maxConcurrentRaw;
  }

  const agent: AgentConfig = {
    kind,
    timeoutMs,
    model: resolveStr(a.model, env),
    maxConcurrent,
  };

  const cp = section(raw, "copilot");
  const copilot: CopilotConfig = {
    allowAllTools: cp.allow_all_tools === true,
    allowTools:
      Array.isArray(cp.allow_tools) &&
      cp.allow_tools.every((x) => typeof x === "string")
        ? (cp.allow_tools as string[])
        : [],
    denyTools:
      Array.isArray(cp.deny_tools) &&
      cp.deny_tools.every((x) => typeof x === "string")
        ? (cp.deny_tools as string[])
        : [],
  };

  const cc = section(raw, "claude_code");
  const claudeCode: ClaudeCodeConfig = {
    permissionMode: resolveStr(cc.permission_mode, env) ?? "bypassPermissions",
    denyTools:
      Array.isArray(cc.deny_tools) &&
      cc.deny_tools.every((x) => typeof x === "string")
        ? (cc.deny_tools as string[])
        : [],
  };

  return { tracker, workspace, hooks, agent, copilot, claudeCode };
}

export async function loadReviewConfig(
  filePath: string,
  env: Env = process.env,
): Promise<{ config: ReviewConfig; promptTemplate: string }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    throw new Error(`cannot read review file: ${filePath}`, { cause: e });
  }

  const { raw, body: promptTemplate } = parseFrontMatter(text);
  const config = parseReviewConfig(raw, env);

  return { config, promptTemplate };
}
