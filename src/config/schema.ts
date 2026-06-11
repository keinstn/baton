import os from "node:os";
import path from "node:path";
import { BatonError } from "../errors.js";
import { norm } from "../util.js";

export interface TrackerConfig {
  kind: string | null;
  endpoint: string;
  token: string | null;
  owner: string | null;
  ownerType: "organization" | "user";
  projectNumber: number | null;
  statusField: string;
  priorityField: string | null;
  repos: string[] | null;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
}

export interface AgentConfig {
  kind: string | null;
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface ClaudeCodeConfig {
  command: string;
  model: string | null;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string | null;
  extraArgs: string[];
  turnTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface CopilotConfig {
  command: string;
  model: string | null;
  allowAllTools: boolean;
  allowTools: string[];
  denyTools: string[];
  extraArgs: string[];
  turnTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface BatonConfig {
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: HooksConfig;
  agent: AgentConfig;
  claudeCode: ClaudeCodeConfig;
  copilot: CopilotConfig;
}

export const SUPPORTED_TRACKER_KINDS = ["github_projects"];
export const SUPPORTED_AGENT_KINDS = ["claude_code", "copilot"];

type Env = Record<string, string | undefined>;

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function section(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = raw[key];
  return isMap(v) ? v : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  return v as string[];
}

/** Positive-integer field; present-but-invalid fails configuration (SPEC §5.3.4/§5.3.5). */
function optPosInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  throw new BatonError(
    "config_invalid",
    `${name} must be a positive integer, got ${String(v)}`,
  );
}

/** Any-integer field (stall_timeout_ms may be <= 0 to disable stall detection). */
function optInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new BatonError(
    "config_invalid",
    `${name} must be an integer, got ${String(v)}`,
  );
}

/**
 * Resolve `$VAR_NAME` indirection (SPEC §6.1). A value that is exactly `$NAME`
 * is replaced by the environment variable; empty/unset resolves to null
 * ("treat as missing"). Any other value passes through unchanged.
 */
export function resolveEnvValue(
  v: string,
  env: Env = process.env,
): string | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(v.trim());
  if (!m) return v;
  const resolved = env[m[1] as string];
  return resolved ? resolved : null;
}

/**
 * Expand a local filesystem path value (SPEC §6.1): `$VAR` indirection,
 * `~` home expansion, then resolution relative to the WORKFLOW.md directory.
 */
export function expandPath(
  p: string,
  baseDir: string,
  env: Env = process.env,
): string {
  const resolved = resolveEnvValue(p, env);
  if (resolved === null) {
    throw new BatonError(
      "config_invalid",
      `path value ${p} resolves to an empty value`,
    );
  }
  let v = resolved;
  if (v === "~" || v.startsWith("~/")) {
    v = path.join(os.homedir(), v.slice(1));
  }
  return path.resolve(baseDir, v);
}

/** Build the typed config view from raw front matter (SPEC §6.1, defaults per §6.4). */
export function buildConfig(
  raw: Record<string, unknown>,
  baseDir: string,
  env: Env = process.env,
): BatonConfig {
  const t = section(raw, "tracker");
  const tokenRaw = str(t.token) ?? "$GITHUB_TOKEN";
  const projectNumberRaw = t.project_number;
  const tracker: TrackerConfig = {
    kind: str(t.kind),
    endpoint: str(t.endpoint) ?? "https://api.github.com/graphql",
    token: resolveEnvValue(tokenRaw, env),
    owner: str(t.owner),
    ownerType: t.owner_type === "user" ? "user" : "organization",
    projectNumber:
      typeof projectNumberRaw === "number" &&
      Number.isInteger(projectNumberRaw) &&
      projectNumberRaw > 0
        ? projectNumberRaw
        : null,
    statusField: str(t.status_field) ?? "Status",
    priorityField: str(t.priority_field),
    repos: strList(t.repos),
    requiredLabels: strList(t.required_labels) ?? [],
    activeStates: strList(t.active_states) ?? ["Todo", "In Progress"],
    terminalStates: strList(t.terminal_states) ?? ["Done"],
  };

  const p = section(raw, "polling");
  const polling = {
    intervalMs: optPosInt(p.interval_ms, "polling.interval_ms") ?? 30000,
  };

  const w = section(raw, "workspace");
  const rootRaw = str(w.root);
  const workspace = {
    root: rootRaw
      ? expandPath(rootRaw, baseDir, env)
      : path.join(os.tmpdir(), "baton_workspaces"),
  };

  const h = section(raw, "hooks");
  const hooks: HooksConfig = {
    afterCreate: str(h.after_create),
    beforeRun: str(h.before_run),
    afterRun: str(h.after_run),
    beforeRemove: str(h.before_remove),
    timeoutMs: optPosInt(h.timeout_ms, "hooks.timeout_ms") ?? 60000,
  };

  const a = section(raw, "agent");
  const byStateRaw = a.max_concurrent_agents_by_state;
  const maxConcurrentAgentsByState: Record<string, number> = {};
  if (isMap(byStateRaw)) {
    // Invalid entries (non-positive or non-numeric) are ignored (SPEC §5.3.5).
    for (const [key, value] of Object.entries(byStateRaw)) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        maxConcurrentAgentsByState[norm(key)] = value;
      }
    }
  }
  const agent: AgentConfig = {
    kind: str(a.kind),
    maxConcurrentAgents:
      optPosInt(a.max_concurrent_agents, "agent.max_concurrent_agents") ?? 10,
    maxTurns: optPosInt(a.max_turns, "agent.max_turns") ?? 20,
    maxRetryBackoffMs:
      optPosInt(a.max_retry_backoff_ms, "agent.max_retry_backoff_ms") ?? 300000,
    maxConcurrentAgentsByState,
  };

  const cc = section(raw, "claude_code");
  const claudeCode: ClaudeCodeConfig = {
    command: str(cc.command) ?? "claude",
    model: str(cc.model),
    permissionMode: str(cc.permission_mode) ?? "acceptEdits",
    allowedTools: strList(cc.allowed_tools) ?? [],
    disallowedTools: strList(cc.disallowed_tools) ?? [],
    appendSystemPrompt: str(cc.append_system_prompt),
    extraArgs: strList(cc.extra_args) ?? [],
    turnTimeoutMs:
      optPosInt(cc.turn_timeout_ms, "claude_code.turn_timeout_ms") ?? 3600000,
    stallTimeoutMs:
      optInt(cc.stall_timeout_ms, "claude_code.stall_timeout_ms") ?? 300000,
  };

  const cp = section(raw, "copilot");
  const copilot: CopilotConfig = {
    command: str(cp.command) ?? "copilot",
    model: str(cp.model),
    allowAllTools: cp.allow_all_tools === true,
    allowTools: strList(cp.allow_tools) ?? [],
    denyTools: strList(cp.deny_tools) ?? [],
    extraArgs: strList(cp.extra_args) ?? [],
    turnTimeoutMs:
      optPosInt(cp.turn_timeout_ms, "copilot.turn_timeout_ms") ?? 3600000,
    stallTimeoutMs:
      optInt(cp.stall_timeout_ms, "copilot.stall_timeout_ms") ?? 300000,
  };

  return { tracker, polling, workspace, hooks, agent, claudeCode, copilot };
}

export interface ValidationError {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/** Dispatch preflight validation (SPEC §6.3). Static checks only; project/field
 *  resolution is validated lazily by the tracker client. */
export function validateDispatchConfig(config: BatonConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const { tracker, agent } = config;

  if (!tracker.kind || !SUPPORTED_TRACKER_KINDS.includes(tracker.kind)) {
    errors.push({
      code: "unsupported_tracker_kind",
      message: `tracker.kind must be one of: ${SUPPORTED_TRACKER_KINDS.join(", ")}`,
    });
  }
  if (!tracker.token) {
    errors.push({
      code: "missing_tracker_token",
      message:
        "tracker.token is missing after $VAR resolution (set GITHUB_TOKEN)",
    });
  }
  if (!tracker.owner || tracker.projectNumber === null) {
    errors.push({
      code: "missing_tracker_project",
      message: "tracker.owner and tracker.project_number are required",
    });
  }
  if (!agent.kind || !SUPPORTED_AGENT_KINDS.includes(agent.kind)) {
    errors.push({
      code: "unsupported_agent_kind",
      message: `agent.kind must be one of: ${SUPPORTED_AGENT_KINDS.join(", ")}`,
    });
  } else {
    const command =
      agent.kind === "claude_code"
        ? config.claudeCode.command
        : config.copilot.command;
    if (!command || command.trim() === "") {
      errors.push({
        code: "missing_agent_command",
        message: `${agent.kind}.command must be present and non-empty`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}
