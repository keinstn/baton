import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BatonConfig, buildConfig } from "../src/config/schema.js";
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

/** Create a fresh temp dir plus a `ws` workspace subdir for a mock agent. */
export async function mockAgentDir(
  prefix = "baton-mock-",
): Promise<{ dir: string; workspace: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(dir, "ws");
  await mkdir(workspace);
  return { dir, workspace };
}

/**
 * Write a CommonJS node script that stands in for an agent CLI, and return the
 * `command` string to run it. Using `node <script>` keeps mocks cross-platform
 * (no `#!/usr/bin/env bash` shebang, which Windows cannot execute). The path is
 * quoted so it survives splitCommand even if it contains spaces; `.cjs` forces
 * CommonJS regardless of any ambient package.json.
 */
export async function writeMockAgent(
  dir: string,
  body: string,
): Promise<string> {
  const file = join(dir, "mock.cjs");
  await writeFile(file, body);
  return `node "${file}"`;
}

/** Convenience: create the dir/workspace and write the mock body in one call. */
export async function makeMockAgent(
  body: string,
  prefix = "baton-mock-",
): Promise<{ command: string; workspace: string; dir: string }> {
  const { dir, workspace } = await mockAgentDir(prefix);
  const command = await writeMockAgent(dir, body);
  return { command, workspace, dir };
}
