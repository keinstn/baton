#!/usr/bin/env node
import path from "node:path";
import { Logger } from "../../src/observability/logger.js";
import { ensureGitBashOnWindowsPath } from "../../src/platform/git-bash.js";
import { isRecord, norm } from "../../src/util.js";
import { classifyItem } from "./classify.js";
import { loadReviewSyncConfig, type ReviewSyncConfig } from "./config.js";

ensureGitBashOnWindowsPath();

const logger = new Logger({ service: "review-sync" });

const NETWORK_TIMEOUT_MS = 30_000;
const ITEMS_PAGE_SIZE = 50;

// --- GraphQL helper ---

async function gql(
  endpoint: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error("GraphQL response is not an object");
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(
      `GraphQL errors: ${JSON.stringify(body.errors).slice(0, 500)}`,
    );
  }
  if (!isRecord(body.data)) throw new Error("GraphQL response has no data");
  return body.data;
}

// --- Queries ---

function projectSetupQuery(ownerField: "organization" | "user"): string {
  return `
query ReviewSyncProject($owner: String!, $number: Int!) {
  ${ownerField}(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;
}

const ITEMS_QUERY = `
query ReviewSyncItems($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: ${ITEMS_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 50) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              id
              number
              title
            }
          }
        }
      }
    }
  }
}`;

const LINKED_PRS_QUERY = `
query ReviewSyncLinkedPRs($issueId: ID!, $after: String) {
  node(id: $issueId) {
    ... on Issue {
      timelineItems(first: 50, after: $after, itemTypes: [CROSS_REFERENCED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest {
                id
                number
                state
              }
            }
          }
        }
      }
    }
  }
}`;

const REVIEW_THREADS_QUERY = `
query ReviewSyncThreads($prId: ID!, $after: String) {
  node(id: $prId) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
        }
      }
    }
  }
}`;

const MOVE_MUTATION = `
mutation ReviewSyncMove($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

// --- Types ---

interface ProjectMeta {
  projectId: string;
  statusFieldId: string;
  optionsByName: Map<string, string>;
}

interface ProjectItem {
  itemId: string;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  currentState: string;
}

interface LinkedPR {
  id: string;
  number: number;
  state: string;
}

// --- Setup ---

async function resolveProject(
  cfg: ReviewSyncConfig,
  token: string,
): Promise<ProjectMeta> {
  const query = projectSetupQuery(cfg.ownerType);
  const data = await gql(cfg.endpoint, token, query, {
    owner: cfg.owner,
    number: cfg.projectNumber,
  });
  const ownerData = data[cfg.ownerType];
  if (!isRecord(ownerData)) {
    throw new Error(
      `project ${cfg.owner}/#${cfg.projectNumber} not found (check token scopes)`,
    );
  }
  const projectV2 = ownerData.projectV2;
  if (!isRecord(projectV2) || typeof projectV2.id !== "string") {
    throw new Error(
      `project ${cfg.owner}/#${cfg.projectNumber} not found (check token scopes)`,
    );
  }
  const projectId = projectV2.id;
  const fieldsConn = projectV2.fields;
  const fieldNodes =
    isRecord(fieldsConn) && Array.isArray(fieldsConn.nodes)
      ? fieldsConn.nodes
      : [];

  let statusFieldId: string | null = null;
  const optionsByName = new Map<string, string>();

  for (const rawField of fieldNodes) {
    if (!isRecord(rawField)) continue;
    if (typeof rawField.name !== "string") continue;
    if (norm(rawField.name) !== norm("Status")) continue;
    if (typeof rawField.id !== "string") continue;
    statusFieldId = rawField.id;
    const opts = Array.isArray(rawField.options) ? rawField.options : [];
    for (const opt of opts) {
      if (!isRecord(opt)) continue;
      if (typeof opt.id === "string" && typeof opt.name === "string") {
        optionsByName.set(norm(opt.name), opt.id);
      }
    }
    break;
  }

  if (!statusFieldId || optionsByName.size === 0) {
    throw new Error('single-select field "Status" not found on project');
  }

  return { projectId, statusFieldId, optionsByName };
}

// --- Fetch items ---

async function fetchSourceItems(
  cfg: ReviewSyncConfig,
  token: string,
  meta: ProjectMeta,
): Promise<ProjectItem[]> {
  const wantedStates = new Set(cfg.sourceStates.map(norm));
  const items: ProjectItem[] = [];
  let after: string | null = null;

  for (;;) {
    const data = await gql(cfg.endpoint, token, ITEMS_QUERY, {
      projectId: meta.projectId,
      after,
    });
    const nodeData = data.node;
    const itemsConn = isRecord(nodeData) ? nodeData.items : undefined;
    if (!isRecord(itemsConn)) throw new Error("items connection missing");

    const nodes = Array.isArray(itemsConn.nodes) ? itemsConn.nodes : [];
    for (const rawNode of nodes) {
      if (!isRecord(rawNode)) continue;
      const itemId = typeof rawNode.id === "string" ? rawNode.id : null;
      if (!itemId) continue;

      let currentState = "";
      const fvConn = rawNode.fieldValues;
      if (isRecord(fvConn) && Array.isArray(fvConn.nodes)) {
        for (const fv of fvConn.nodes) {
          if (!isRecord(fv)) continue;
          const fieldObj = fv.field;
          if (
            isRecord(fieldObj) &&
            typeof fieldObj.name === "string" &&
            norm(fieldObj.name) === norm("Status") &&
            typeof fv.name === "string"
          ) {
            currentState = fv.name;
            break;
          }
        }
      }

      if (!wantedStates.has(norm(currentState))) continue;

      const content = rawNode.content;
      if (!isRecord(content) || content.__typename !== "Issue") continue;
      if (
        typeof content.id !== "string" ||
        typeof content.number !== "number"
      ) {
        continue;
      }

      items.push({
        itemId,
        issueId: content.id,
        issueNumber: content.number,
        issueTitle: typeof content.title === "string" ? content.title : "",
        currentState,
      });
    }

    const pageInfo = isRecord(itemsConn.pageInfo) ? itemsConn.pageInfo : null;
    if (!pageInfo?.hasNextPage) break;
    if (typeof pageInfo.endCursor !== "string") {
      throw new Error("hasNextPage without endCursor (items)");
    }
    after = pageInfo.endCursor;
  }

  return items;
}

// --- Linked PRs ---

async function fetchLinkedOpenPRs(
  cfg: ReviewSyncConfig,
  token: string,
  issueId: string,
): Promise<LinkedPR[]> {
  const prs: LinkedPR[] = [];
  let after: string | null = null;

  for (;;) {
    const data = await gql(cfg.endpoint, token, LINKED_PRS_QUERY, {
      issueId,
      after,
    });
    const nodeData = data.node;
    const timelineConn = isRecord(nodeData)
      ? nodeData.timelineItems
      : undefined;
    if (!isRecord(timelineConn)) break;

    const nodes = Array.isArray(timelineConn.nodes) ? timelineConn.nodes : [];
    for (const rawNode of nodes) {
      if (!isRecord(rawNode)) continue;
      const source = rawNode.source;
      if (!isRecord(source)) continue;
      if (
        typeof source.id === "string" &&
        typeof source.number === "number" &&
        typeof source.state === "string"
      ) {
        prs.push({ id: source.id, number: source.number, state: source.state });
      }
    }

    const pageInfo = isRecord(timelineConn.pageInfo)
      ? timelineConn.pageInfo
      : null;
    if (!pageInfo?.hasNextPage) break;
    if (typeof pageInfo.endCursor !== "string") {
      throw new Error("hasNextPage without endCursor (timeline)");
    }
    after = pageInfo.endCursor;
  }

  return prs.filter((pr) => pr.state === "OPEN");
}

// --- Review threads ---

async function fetchPRThreadStatus(
  cfg: ReviewSyncConfig,
  token: string,
  prId: string,
): Promise<{ hasThreads: boolean; allResolved: boolean }> {
  let hasThreads = false;
  let allResolved = true;
  let after: string | null = null;

  for (;;) {
    const data = await gql(cfg.endpoint, token, REVIEW_THREADS_QUERY, {
      prId,
      after,
    });
    const nodeData = data.node;
    const threadsConn = isRecord(nodeData) ? nodeData.reviewThreads : undefined;
    if (!isRecord(threadsConn)) break;

    const nodes = Array.isArray(threadsConn.nodes) ? threadsConn.nodes : [];
    for (const rawNode of nodes) {
      if (!isRecord(rawNode) || typeof rawNode.isResolved !== "boolean") {
        continue;
      }
      hasThreads = true;
      if (!rawNode.isResolved) {
        allResolved = false;
      }
    }

    const pageInfo = isRecord(threadsConn.pageInfo)
      ? threadsConn.pageInfo
      : null;
    if (!pageInfo?.hasNextPage) break;
    if (typeof pageInfo.endCursor !== "string") {
      throw new Error("hasNextPage without endCursor (review threads)");
    }
    after = pageInfo.endCursor;
  }

  return { hasThreads, allResolved };
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const configPath =
    args.find((a) => !a.startsWith("--")) ??
    path.join(process.cwd(), "REVIEW_SYNC.md");

  logger.info("loading review-sync config", {
    path: configPath,
    dry_run: dryRun,
  });
  const cfg = await loadReviewSyncConfig(configPath);

  if (!cfg.token) {
    throw new Error(
      "tracker.token is required — set GITHUB_TOKEN or provide it in REVIEW_SYNC.md",
    );
  }
  const token = cfg.token;

  logger.info("resolving project", {
    owner: cfg.owner,
    project: cfg.projectNumber,
  });
  const meta = await resolveProject(cfg, token);
  logger.info("project resolved", {
    project_id: meta.projectId,
    options: [...meta.optionsByName.keys()],
  });

  for (const state of [cfg.inProgressState, cfg.inReviewState]) {
    if (!meta.optionsByName.has(norm(state))) {
      throw new Error(
        `state "${state}" not found in project options: ${[...meta.optionsByName.keys()].join(", ")}`,
      );
    }
  }

  logger.info("fetching source items", { source_states: cfg.sourceStates });
  const items = await fetchSourceItems(cfg, token, meta);
  logger.info("found items in source states", { count: items.length });

  let moved = 0;
  let skipped = 0;
  let alreadyInTarget = 0;
  let errors = 0;

  for (const item of items) {
    const itemLogger = logger.child({
      issue: item.issueNumber,
      title: item.issueTitle,
      current_state: item.currentState,
    });

    try {
      const openPRs = await fetchLinkedOpenPRs(cfg, token, item.issueId);
      itemLogger.debug("linked open PRs", {
        count: openPRs.length,
        numbers: openPRs.map((p) => p.number),
      });

      const threadStatuses: Array<{
        hasThreads: boolean;
        allResolved: boolean;
      }> = [];
      for (const pr of openPRs) {
        threadStatuses.push(await fetchPRThreadStatus(cfg, token, pr.id));
      }

      const decision = classifyItem(
        threadStatuses,
        item.currentState,
        cfg.inProgressState,
        cfg.inReviewState,
      );

      if (decision.action === "skip") {
        itemLogger.info(
          decision.reason === "no_open_prs"
            ? "skip: no linked open PRs"
            : "skip: no review threads on linked open PRs",
        );
        skipped++;
        continue;
      }

      if (decision.action === "noop") {
        itemLogger.info("already in target state, skipping", {
          state: item.currentState,
        });
        alreadyInTarget++;
        continue;
      }

      const { targetState } = decision;
      const optionId = meta.optionsByName.get(norm(targetState));
      if (!optionId) {
        throw new Error(`state "${targetState}" not found in project options`);
      }

      if (dryRun) {
        itemLogger.info("dry-run: would move", {
          from: item.currentState,
          to: targetState,
        });
        moved++;
        continue;
      }

      await gql(cfg.endpoint, token, MOVE_MUTATION, {
        projectId: meta.projectId,
        itemId: item.itemId,
        fieldId: meta.statusFieldId,
        optionId,
      });

      itemLogger.info("moved", { from: item.currentState, to: targetState });
      moved++;
    } catch (err) {
      itemLogger.error("error processing issue", { error: String(err) });
      errors++;
    }
  }

  logger.info("review-sync complete", {
    moved,
    skipped,
    already_in_target: alreadyInTarget,
    errors,
    dry_run: dryRun,
  });

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error("review-sync failed", { error: String(err) });
  process.exit(1);
});
