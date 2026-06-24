import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTriageConfig,
  parseTriageConfig,
} from "../scripts/triage/config.js";

const BASE_RAW = {
  tracker: { owner: "acme", project_number: 1 },
  evaluator: { kind: "claude_code" },
};

describe("parseTriageConfig defaults", () => {
  it("applies documented defaults for tracker fields", () => {
    const config = parseTriageConfig(BASE_RAW, { GITHUB_TOKEN: "test-token" });
    expect(config.tracker.token).toBe("test-token");
    expect(config.tracker.endpoint).toBe("https://api.github.com/graphql");
    expect(config.tracker.ownerType).toBe("organization");
    expect(config.tracker.statusField).toBe("Status");
    expect(config.tracker.todoState).toBe("Todo");
    expect(config.tracker.aiReadyLabel).toBe("ai-ready");
    expect(config.tracker.owner).toBe("acme");
    expect(config.tracker.projectNumber).toBe(1);
  });

  it("applies documented defaults for evaluator fields", () => {
    const config = parseTriageConfig(BASE_RAW, {});
    expect(config.evaluator.command).toBe("claude");
    expect(config.evaluator.model).toBeNull();
    expect(config.evaluator.timeoutMs).toBe(60000);
  });

  it("defaults evaluator.command to 'copilot' for copilot kind", () => {
    const config = parseTriageConfig(
      {
        tracker: { owner: "acme", project_number: 1 },
        evaluator: { kind: "copilot" },
      },
      {},
    );
    expect(config.evaluator.command).toBe("copilot");
  });
});

describe("parseTriageConfig required fields", () => {
  it("throws when tracker.owner is missing", () => {
    expect(() =>
      parseTriageConfig(
        { tracker: { project_number: 1 }, evaluator: { kind: "claude_code" } },
        {},
      ),
    ).toThrow(/tracker\.owner/);
  });

  it("throws when tracker.owner is empty string", () => {
    expect(() =>
      parseTriageConfig(
        {
          tracker: { owner: "", project_number: 1 },
          evaluator: { kind: "claude_code" },
        },
        {},
      ),
    ).toThrow(/tracker\.owner/);
  });

  it("throws when tracker.project_number is missing", () => {
    expect(() =>
      parseTriageConfig(
        { tracker: { owner: "acme" }, evaluator: { kind: "claude_code" } },
        {},
      ),
    ).toThrow(/tracker\.project_number/);
  });

  it("throws when tracker.project_number is not a positive integer", () => {
    expect(() =>
      parseTriageConfig(
        {
          tracker: { owner: "acme", project_number: -1 },
          evaluator: { kind: "claude_code" },
        },
        {},
      ),
    ).toThrow(/tracker\.project_number/);

    expect(() =>
      parseTriageConfig(
        {
          tracker: { owner: "acme", project_number: "one" },
          evaluator: { kind: "claude_code" },
        },
        {},
      ),
    ).toThrow(/tracker\.project_number/);
  });

  it("throws when evaluator.kind is missing", () => {
    expect(() =>
      parseTriageConfig(
        { tracker: { owner: "acme", project_number: 1 }, evaluator: {} },
        {},
      ),
    ).toThrow(/evaluator\.kind/);
  });

  it("throws when evaluator.kind is unsupported", () => {
    expect(() =>
      parseTriageConfig(
        {
          tracker: { owner: "acme", project_number: 1 },
          evaluator: { kind: "openai" },
        },
        {},
      ),
    ).toThrow(/evaluator\.kind/);
  });
});

describe("$VAR resolution", () => {
  it("resolves tracker.token from $GITHUB_TOKEN by default", () => {
    const config = parseTriageConfig(BASE_RAW, { GITHUB_TOKEN: "ghp_abc" });
    expect(config.tracker.token).toBe("ghp_abc");
  });

  it("resolves tracker.token to null when GITHUB_TOKEN is unset", () => {
    const config = parseTriageConfig(BASE_RAW, {});
    expect(config.tracker.token).toBeNull();
  });

  it("resolves explicit $VAR tracker.token", () => {
    const config = parseTriageConfig(
      {
        ...BASE_RAW,
        tracker: { owner: "acme", project_number: 1, token: "$MY_PAT" },
      },
      { MY_PAT: "my-token" },
    );
    expect(config.tracker.token).toBe("my-token");
  });

  it("resolves explicit $VAR to null when unset", () => {
    const config = parseTriageConfig(
      {
        ...BASE_RAW,
        tracker: { owner: "acme", project_number: 1, token: "$MISSING_VAR" },
      },
      {},
    );
    expect(config.tracker.token).toBeNull();
  });

  it("passes through literal token values unchanged", () => {
    const config = parseTriageConfig(
      {
        ...BASE_RAW,
        tracker: { owner: "acme", project_number: 1, token: "literal-token" },
      },
      {},
    );
    expect(config.tracker.token).toBe("literal-token");
  });
});

describe("evaluator.command defaults", () => {
  it("defaults to 'claude' for claude_code kind", () => {
    const config = parseTriageConfig(BASE_RAW, {});
    expect(config.evaluator.command).toBe("claude");
  });

  it("defaults to 'copilot' for copilot kind", () => {
    const config = parseTriageConfig(
      {
        tracker: { owner: "acme", project_number: 1 },
        evaluator: { kind: "copilot" },
      },
      {},
    );
    expect(config.evaluator.command).toBe("copilot");
  });

  it("uses explicit command when provided", () => {
    const config = parseTriageConfig(
      {
        tracker: { owner: "acme", project_number: 1 },
        evaluator: { kind: "claude_code", command: "/usr/local/bin/claude" },
      },
      {},
    );
    expect(config.evaluator.command).toBe("/usr/local/bin/claude");
  });
});

describe("loadTriageConfig", () => {
  it("parses a valid TRIAGE.md and returns config + prompt body", async () => {
    const content = [
      "---",
      "tracker:",
      "  owner: myorg",
      "  project_number: 42",
      "  token: $MY_TOKEN",
      "evaluator:",
      "  kind: claude_code",
      "  model: claude-3-5-sonnet",
      "---",
      "Evaluate whether this issue is ready for an AI agent.",
    ].join("\n");

    const filePath = join(tmpdir(), `triage-test-${Date.now()}.md`);
    await writeFile(filePath, content, "utf8");

    const { config, promptTemplate } = await loadTriageConfig(filePath, {
      MY_TOKEN: "tok123",
    });

    expect(config.tracker.owner).toBe("myorg");
    expect(config.tracker.projectNumber).toBe(42);
    expect(config.tracker.token).toBe("tok123");
    expect(config.evaluator.kind).toBe("claude_code");
    expect(config.evaluator.model).toBe("claude-3-5-sonnet");
    expect(config.evaluator.command).toBe("claude");
    expect(promptTemplate).toBe(
      "Evaluate whether this issue is ready for an AI agent.",
    );
  });

  it("returns the prompt template body after the front matter", async () => {
    const content = [
      "---",
      "tracker:",
      "  owner: acme",
      "  project_number: 1",
      "evaluator:",
      "  kind: copilot",
      "---",
      "This is the prompt template body.",
      "It can span multiple lines.",
    ].join("\n");

    const filePath = join(tmpdir(), `triage-test-body-${Date.now()}.md`);
    await writeFile(filePath, content, "utf8");

    const { config, promptTemplate } = await loadTriageConfig(filePath, {});

    expect(config.tracker.owner).toBe("acme");
    expect(config.evaluator.kind).toBe("copilot");
    expect(promptTemplate).toBe(
      "This is the prompt template body.\nIt can span multiple lines.",
    );
  });

  it("throws on missing file", async () => {
    await expect(
      loadTriageConfig("/nonexistent/path/TRIAGE.md"),
    ).rejects.toThrow(/cannot read triage file/);
  });
});
