#!/usr/bin/env node
import path from "node:path";
import { Logger } from "../../src/observability/logger.js";
import { ensureGitBashOnWindowsPath } from "../../src/platform/git-bash.js";
import { addLabel, postComment } from "./actions.js";
import { loadTriageConfig } from "./config.js";
import { createEvaluator } from "./evaluator.js";
import { fetchAndGroup } from "./fetcher.js";

ensureGitBashOnWindowsPath();

const logger = new Logger({ service: "triage" });

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? path.join(process.cwd(), "TRIAGE.md");

  logger.info("loading triage config", { path: configPath });
  const { config, promptTemplate } = await loadTriageConfig(configPath);

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
  let totalEvalErrors = 0;
  let totalActionErrors = 0;

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
      totalEvalErrors++;
      continue;
    }

    const fetchedNumbers = new Set(issues.map((i) => i.number));
    const missing = issues
      .map((i) => i.number)
      .filter((n) => !decisions.some((d) => d.number === n));
    if (missing.length > 0) {
      repoLogger.warn("evaluator returned no decision for some issues", {
        missing_issue_numbers: missing,
      });
    }

    const validDecisions = decisions.filter((d) => {
      if (!fetchedNumbers.has(d.number)) {
        repoLogger.warn(
          "evaluator returned decision for unknown issue, skipping",
          { issue_number: d.number },
        );
        return false;
      }
      return true;
    });

    for (const decision of validDecisions) {
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
          const comment =
            decision.comment ||
            (() => {
              issueLogger.warn(
                "needs_clarification decision missing comment, falling back to reason",
              );
              return decision.reason;
            })();
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
        totalActionErrors++;
      }
    }
  }

  logger.info("triage complete", {
    ready: totalReady,
    needs_clarification: totalClarification,
    skipped: totalSkipped,
    eval_errors: totalEvalErrors,
    action_errors: totalActionErrors,
  });
}

main().catch((err) => {
  logger.error("triage failed", { error: String(err) });
  process.exit(1);
});
