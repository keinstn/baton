#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../../src/observability/logger.js";
import { ensureGitBashOnWindowsPath } from "../../src/platform/git-bash.js";
import { addLabel, postComment } from "./actions.js";
import { loadTriageConfig } from "./config.js";
import { createEvaluator } from "./evaluator.js";
import { fetchAndGroup } from "./fetcher.js";

const DEFAULT_PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "prompt.md",
);

ensureGitBashOnWindowsPath();

const logger = new Logger({ service: "triage" });

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? path.join(process.cwd(), "TRIAGE.md");

  logger.info("loading triage config", { path: configPath });
  const { config, promptTemplate: rawPromptTemplate } =
    await loadTriageConfig(configPath);

  const promptTemplate =
    rawPromptTemplate.length > 0
      ? rawPromptTemplate
      : await readFile(DEFAULT_PROMPT_PATH, "utf8");

  const token = config.tracker.token;
  if (!token) {
    throw new Error(
      "tracker.token is required — set GITHUB_TOKEN or provide it in TRIAGE.md",
    );
  }

  logger.info("fetching issues", {
    owner: config.tracker.owner,
    project: config.tracker.projectNumber,
    todo_state: config.tracker.todoState,
  });

  const repoGroups = await fetchAndGroup(config.tracker);
  logger.info("fetched issue groups", { repo_count: repoGroups.size });

  const evaluator = createEvaluator(config.evaluator);

  let totalReady = 0;
  let totalClarification = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const [repo, issues] of repoGroups) {
    const repoLogger = logger.child({ repo, issue_count: issues.length });
    repoLogger.info("evaluating repo");

    let decisions: Awaited<ReturnType<typeof evaluator.evaluate>>;
    try {
      decisions = await evaluator.evaluate(issues, promptTemplate, repo);
    } catch (err) {
      repoLogger.error("evaluation failed, skipping repo", {
        error: String(err),
      });
      totalErrors++;
      continue;
    }

    for (const decision of decisions) {
      const issueLogger = repoLogger.child({ issue_number: decision.number });

      try {
        if (decision.decision === "ready") {
          issueLogger.info("adding ai-ready label");
          await addLabel(
            repo,
            decision.number,
            config.tracker.aiReadyLabel,
            token,
          );
          totalReady++;
        } else if (decision.decision === "needs_clarification") {
          const comment = decision.comment ?? decision.reason;
          issueLogger.info("posting clarification comment");
          await postComment(repo, decision.number, comment, token);
          totalClarification++;
        } else {
          issueLogger.debug("issue not ready, skipping", {
            reason: decision.reason,
          });
          totalSkipped++;
        }
      } catch (err) {
        issueLogger.error("action failed", { error: String(err) });
        totalErrors++;
      }
    }
  }

  logger.info("triage complete", {
    ready: totalReady,
    needs_clarification: totalClarification,
    skipped: totalSkipped,
    errors: totalErrors,
  });
}

main().catch((err) => {
  logger.error("triage failed", { error: String(err) });
  process.exit(1);
});
