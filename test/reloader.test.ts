import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type BatonConfig, buildConfig } from "../src/config/schema.js";
import { Logger } from "../src/observability/logger.js";
import { loadWorkflow } from "../src/workflow/loader.js";
import { WorkflowReloader } from "../src/workflow/reloader.js";

/** A valid WORKFLOW.md whose body and concurrency limit can be varied. */
function workflowFile(prompt: string, maxConcurrent = 2): string {
  return [
    "---",
    "tracker:",
    "  kind: github_projects",
    "  token: test-token",
    "  owner: acme",
    "  project_number: 1",
    "agent:",
    "  kind: claude_code",
    `  max_concurrent_agents: ${maxConcurrent}`,
    "---",
    prompt,
  ].join("\n");
}

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = new Logger({}, (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

async function setup(initialPrompt = "first prompt", maxConcurrent = 2) {
  const dir = await mkdtemp(join(tmpdir(), "baton-reload-"));
  const path = join(dir, "WORKFLOW.md");
  await writeFile(path, workflowFile(initialPrompt, maxConcurrent));
  const wf = await loadWorkflow(path);
  const config = buildConfig(wf.config, wf.dir);
  const onApply = vi.fn<(c: BatonConfig) => void>();
  const { logger, lines } = captureLogger();
  const reloader = new WorkflowReloader(
    path,
    { config, promptTemplate: wf.promptTemplate },
    logger,
    onApply,
  );
  return { dir, path, reloader, onApply, lines };
}

describe("WorkflowReloader (SPEC §6.2)", () => {
  it("adopts a valid reload, swapping config + prompt and calling onApply", async () => {
    const { path, reloader, onApply } = await setup("first prompt", 2);
    expect(reloader.promptTemplate()).toBe("first prompt");
    expect(reloader.config().agent.maxConcurrentAgents).toBe(2);

    await writeFile(path, workflowFile("second prompt", 5));
    const ok = await reloader.reload();

    expect(ok).toBe(true);
    expect(reloader.promptTemplate()).toBe("second prompt");
    expect(reloader.config().agent.maxConcurrentAgents).toBe(5);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0].agent.maxConcurrentAgents).toBe(5);
  });

  it("keeps last known good when the reload fails validation", async () => {
    const { path, reloader, onApply, lines } = await setup("good prompt", 3);
    // Remove tracker.owner → loads and builds but fails dispatch validation.
    await writeFile(
      path,
      [
        "---",
        "tracker:",
        "  kind: github_projects",
        "  token: test-token",
        "  project_number: 1",
        "agent:",
        "  kind: claude_code",
        "---",
        "bad prompt",
      ].join("\n"),
    );
    const ok = await reloader.reload();

    expect(ok).toBe(false);
    expect(reloader.promptTemplate()).toBe("good prompt");
    expect(reloader.config().agent.maxConcurrentAgents).toBe(3);
    expect(onApply).not.toHaveBeenCalled();
    expect(lines.some((l) => l["level"] === "error")).toBe(true);
  });

  it("keeps last known good when config building throws", async () => {
    const { path, reloader, onApply } = await setup("good prompt", 3);
    // Negative interval is a present-but-invalid positive integer (config_invalid).
    await writeFile(
      path,
      [
        "---",
        "tracker:",
        "  kind: github_projects",
        "  token: test-token",
        "  owner: acme",
        "  project_number: 1",
        "agent:",
        "  kind: claude_code",
        "polling:",
        "  interval_ms: -5",
        "---",
        "bad prompt",
      ].join("\n"),
    );
    const ok = await reloader.reload();

    expect(ok).toBe(false);
    expect(reloader.promptTemplate()).toBe("good prompt");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps last known good when front matter cannot be parsed", async () => {
    const { path, reloader, onApply } = await setup("good prompt", 3);
    await writeFile(path, "---\nfoo: [unclosed\n---\nbody");
    const ok = await reloader.reload();
    expect(ok).toBe(false);
    expect(reloader.promptTemplate()).toBe("good prompt");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps last known good when the file disappears", async () => {
    const { path, reloader, onApply } = await setup("good prompt", 3);
    await rm(path);
    const ok = await reloader.reload();
    expect(ok).toBe(false);
    expect(reloader.promptTemplate()).toBe("good prompt");
    expect(onApply).not.toHaveBeenCalled();
  });
});
