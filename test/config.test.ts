import os from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConfig,
  resolveEnvValue,
  validateDispatchConfig,
} from "../src/config/schema.js";
import { makeConfig } from "./helpers.js";

describe("buildConfig defaults (SPEC §6.4)", () => {
  it("applies documented defaults", () => {
    const config = makeConfig();
    expect(config.tracker.endpoint).toBe("https://api.github.com/graphql");
    expect(config.tracker.statusField).toBe("Status");
    expect(config.tracker.ownerType).toBe("organization");
    expect(config.tracker.requiredLabels).toEqual([]);
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminalStates).toEqual(["Done"]);
    expect(config.polling.intervalMs).toBe(30000);
    expect(config.workspace.root).toBe(join(os.tmpdir(), "baton_workspaces"));
    expect(config.hooks.timeoutMs).toBe(60000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.agent.maxRetryBackoffMs).toBe(300000);
    expect(config.claudeCode.command).toEqual(["claude"]);
    expect(config.claudeCode.permissionMode).toBe("acceptEdits");
    expect(config.claudeCode.turnTimeoutMs).toBe(3600000);
    expect(config.claudeCode.stallTimeoutMs).toBe(300000);
    expect(config.copilot.command).toEqual(["copilot"]);
    expect(config.copilot.allowAllTools).toBe(false);
  });
});

describe("$VAR resolution (SPEC §6.1)", () => {
  it("resolves $VAR values from the environment", () => {
    expect(resolveEnvValue("$MY_TOKEN", { MY_TOKEN: "abc" })).toBe("abc");
    expect(resolveEnvValue("literal", {})).toBe("literal");
  });

  it("treats empty env resolution as missing", () => {
    expect(resolveEnvValue("$MY_TOKEN", { MY_TOKEN: "" })).toBeNull();
    expect(resolveEnvValue("$MY_TOKEN", {})).toBeNull();
  });

  it("defaults tracker.token to $GITHUB_TOKEN", () => {
    const config = makeConfig({}, "/tmp", { GITHUB_TOKEN: "from-env" });
    expect(config.tracker.token).toBe("from-env");
    const missing = makeConfig({}, "/tmp", {});
    expect(missing.tracker.token).toBeNull();
  });

  it("resolves explicit $VAR tracker.token", () => {
    const config = makeConfig({ tracker: { token: "$MY_PAT" } }, "/tmp", {
      MY_PAT: "pat",
    });
    expect(config.tracker.token).toBe("pat");
  });
});

describe("claude_code/copilot command parsing", () => {
  it("preserves string command as-is (backward-compatible shell path)", () => {
    const config = makeConfig({
      claude_code: { command: "claude --no-color" },
    });
    expect(config.claudeCode.command).toBe("claude --no-color");
  });

  it("accepts a string[] command as-is (preserves paths with spaces)", () => {
    const config = makeConfig({
      claude_code: { command: ["/path with spaces/claude", "--flag"] },
    });
    expect(config.claudeCode.command).toEqual([
      "/path with spaces/claude",
      "--flag",
    ]);
  });

  it("defaults to array command (direct-spawn path, no Git Bash needed)", () => {
    const config = makeConfig();
    expect(config.claudeCode.command).toEqual(["claude"]);
    expect(config.copilot.command).toEqual(["copilot"]);
  });
});

describe("workspace.root path handling (SPEC §5.3.3)", () => {
  it("expands ~", () => {
    const config = makeConfig({ workspace: { root: "~/baton-ws" } });
    expect(config.workspace.root).toBe(join(os.homedir(), "baton-ws"));
  });

  it("resolves relative paths against the workflow directory", () => {
    const base = resolve("/srv/project");
    const config = makeConfig({ workspace: { root: "ws" } }, base);
    expect(config.workspace.root).toBe(join(base, "ws"));
  });
});

describe("invalid numeric config fails validation (SPEC §5.3.4/§5.3.5)", () => {
  it("rejects invalid hooks.timeout_ms", () => {
    expect(() =>
      buildConfig({ hooks: { timeout_ms: "soon" } }, "/tmp", {}),
    ).toThrowError(/hooks.timeout_ms/);
  });

  it("rejects invalid agent.max_turns", () => {
    expect(() =>
      buildConfig({ agent: { max_turns: -1 } }, "/tmp", {}),
    ).toThrowError(/agent.max_turns/);
  });
});

describe("per-state concurrency map (SPEC §5.3.5)", () => {
  it("normalizes keys and ignores invalid entries", () => {
    const config = makeConfig({
      agent: {
        max_concurrent_agents_by_state: {
          "In Progress": 2,
          Todo: 0,
          Review: "many",
        },
      },
    });
    expect(config.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 2,
    });
  });
});

describe("validateDispatchConfig (SPEC §6.3)", () => {
  it("passes a complete config", () => {
    expect(validateDispatchConfig(makeConfig())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("reports each missing requirement", () => {
    const config = buildConfig({}, "/tmp", {});
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("unsupported_tracker_kind");
    expect(codes).toContain("missing_tracker_token");
    expect(codes).toContain("missing_tracker_project");
    expect(codes).toContain("unsupported_agent_kind");
  });

  it("rejects unsupported kinds", () => {
    const config = makeConfig({
      tracker: { kind: "linear" },
      agent: { kind: "codex" },
    });
    const codes = validateDispatchConfig(config).errors.map((e) => e.code);
    expect(codes).toContain("unsupported_tracker_kind");
    expect(codes).toContain("unsupported_agent_kind");
  });

  it("rejects a blank runner command (empty string)", () => {
    const config = makeConfig();
    config.claudeCode.command = "  ";
    const codes = validateDispatchConfig(config).errors.map((e) => e.code);
    expect(codes).toContain("missing_agent_command");
  });

  it("rejects a blank runner command (empty array)", () => {
    const config = makeConfig();
    config.claudeCode.command = [];
    const codes = validateDispatchConfig(config).errors.map((e) => e.code);
    expect(codes).toContain("missing_agent_command");
  });

  it("rejects a blank runner command (whitespace-only first element)", () => {
    const config = makeConfig();
    config.claudeCode.command = ["  "];
    const codes = validateDispatchConfig(config).errors.map((e) => e.code);
    expect(codes).toContain("missing_agent_command");
  });
});
