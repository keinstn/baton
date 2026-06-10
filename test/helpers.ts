import { buildConfig, type BatonConfig } from "../src/config/schema.js";
import { Logger } from "../src/observability/logger.js";
import type { Issue } from "../src/tracker/types.js";

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "I_1",
    itemId: "PVTI_1",
    identifier: "repo-1",
    number: 1,
    repository: "acme/repo",
    title: "Test issue",
    description: "body",
    priority: null,
    state: "Todo",
    closed: false,
    url: "https://github.com/acme/repo/issues/1",
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}

type RawConfig = Record<string, unknown>;

/** Build a valid BatonConfig with per-section raw overrides merged in. */
export function makeConfig(
  raw: Record<string, RawConfig> = {},
  baseDir = "/tmp",
  env: Record<string, string | undefined> = { GITHUB_TOKEN: "test-token" },
): BatonConfig {
  const base: Record<string, RawConfig> = {
    tracker: { kind: "github_projects", owner: "acme", project_number: 1 },
    agent: { kind: "claude_code" },
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(raw)) {
    merged[key] = { ...(base[key] ?? {}), ...value };
  }
  return buildConfig(merged, baseDir, env);
}

export const silentLogger = new Logger({}, () => {});
