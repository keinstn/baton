import { readFile } from "node:fs/promises";
import { resolveEnvValue } from "../../src/config/schema.js";
import { isRecord, parseFrontMatter } from "../../src/util.js";

export interface ReviewSyncConfig {
  token: string | null;
  endpoint: string;
  owner: string;
  ownerType: "organization" | "user";
  projectNumber: number;
  sourceStates: string[];
  inProgressState: string;
  inReviewState: string;
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
    throw new Error(
      `"${key}" must be a map in REVIEW_SYNC.md, got: ${typeof v}`,
    );
  }
  return isRecord(v) ? v : {};
}

export function parseReviewSyncConfig(
  raw: Record<string, unknown>,
  env: Env = process.env,
): ReviewSyncConfig {
  const t = section(raw, "tracker");

  const owner = resolveStr(t.owner, env);
  if (!owner) {
    throw new Error("tracker.owner is required in REVIEW_SYNC.md");
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
      "tracker.project_number is required and must be a positive integer in REVIEW_SYNC.md",
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
      `tracker.owner_type must be "organization" or "user" in REVIEW_SYNC.md, got: ${String(ownerTypeRaw)}`,
    );
  }

  const sourceStatesRaw = t.source_states;
  if (
    !Array.isArray(sourceStatesRaw) ||
    !sourceStatesRaw.every((x) => typeof x === "string") ||
    sourceStatesRaw.length === 0
  ) {
    throw new Error(
      "tracker.source_states must be a non-empty list of strings in REVIEW_SYNC.md",
    );
  }
  const sourceStates = sourceStatesRaw as string[];

  const inProgressState = resolveStr(t.in_progress_state, env) ?? "In Progress";
  const inReviewState = resolveStr(t.in_review_state, env) ?? "In Review";

  const tokenRaw = str(t.token) ?? "$GITHUB_TOKEN";

  return {
    token: resolveEnvValue(tokenRaw, env),
    endpoint: resolveStr(t.endpoint, env) ?? "https://api.github.com/graphql",
    owner,
    ownerType,
    projectNumber,
    sourceStates,
    inProgressState,
    inReviewState,
  };
}

export async function loadReviewSyncConfig(
  filePath: string,
  env: Env = process.env,
): Promise<ReviewSyncConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    throw new Error(`cannot read review-sync file: ${filePath}`, { cause: e });
  }

  const { raw } = parseFrontMatter(text);
  return parseReviewSyncConfig(raw, env);
}
