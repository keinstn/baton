import type { TrackerConfig } from "../../src/config/schema.js";
import { GitHubProjectsClient } from "../../src/tracker/github-projects.js";
import type { Issue } from "../../src/tracker/types.js";
import type { TrackerTriageConfig } from "./config.js";

export interface SubIssueRef {
  number: number;
  title: string;
  url: string;
}

export interface TriageIssue extends Issue {
  openSubIssues: SubIssueRef[];
  hasSubIssues: boolean;
}

function parseLinkNext(link: string | null): string | null {
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

// GHES uses /api/v3 for REST; github.com has no /v3 segment.
// Replace /api/graphql → /api/v3 first, then strip a bare /graphql suffix.
function restBaseFromEndpoint(endpoint: string): string {
  return endpoint
    .replace(/\/api\/graphql$/, "/api/v3")
    .replace(/\/graphql$/, "");
}

function toTrackerConfig(config: TrackerTriageConfig): TrackerConfig {
  return {
    kind: "github_projects",
    endpoint: config.endpoint,
    token: config.token,
    owner: config.owner,
    ownerType: config.ownerType,
    projectNumber: config.projectNumber,
    statusField: config.statusField,
    priorityField: null,
    repos: config.repos,
    requiredLabels: [],
    activeStates: [config.todoState],
    terminalStates: [],
  };
}

async function fetchSubIssueInfo(
  restBase: string,
  token: string | null,
  owner: string,
  repo: string,
  issueNumber: number,
  fetchFn: typeof fetch,
): Promise<{ hasSubIssues: boolean; openSubIssues: SubIssueRef[] }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let hasSubIssues = false;
  let fetchError = false;
  const openSubIssues: SubIssueRef[] = [];
  let nextUrl: string | null =
    `${restBase}/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`;

  while (nextUrl !== null) {
    const resp = await fetchFn(nextUrl, { headers });
    if (!resp.ok) {
      fetchError = true;
      break;
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      fetchError = true;
      break;
    }
    if (!Array.isArray(data)) {
      fetchError = true;
      break;
    }
    for (const s of data) {
      if (
        s !== null &&
        typeof s === "object" &&
        "number" in s &&
        typeof s.number === "number" &&
        "title" in s &&
        typeof s.title === "string" &&
        "html_url" in s &&
        typeof s.html_url === "string" &&
        "state" in s &&
        typeof s.state === "string"
      ) {
        hasSubIssues = true;
        if (s.state === "open") {
          openSubIssues.push({
            number: s.number,
            title: s.title,
            url: s.html_url,
          });
        }
      }
    }
    nextUrl = parseLinkNext(resp.headers.get("link"));
  }

  return { hasSubIssues: fetchError || hasSubIssues, openSubIssues };
}

export async function fetchAndGroup(
  config: TrackerTriageConfig,
  fetchFn?: typeof fetch,
): Promise<Map<string, TriageIssue[]>> {
  const fn = fetchFn ?? globalThis.fetch;
  const client = new GitHubProjectsClient(toTrackerConfig(config), fn);
  const issues = await client.fetchIssuesByStates([config.todoState]);

  const restBase = restBaseFromEndpoint(config.endpoint);

  // Sequential to avoid hitting GitHub secondary rate limits on concurrent bursts.
  const triageIssues: TriageIssue[] = [];
  for (const issue of issues) {
    const parts = issue.repository.split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    const { hasSubIssues, openSubIssues } = await fetchSubIssueInfo(
      restBase,
      config.token,
      owner,
      repo,
      issue.number,
      fn,
    );
    triageIssues.push({ ...issue, openSubIssues, hasSubIssues });
  }

  const map = new Map<string, TriageIssue[]>();
  for (const issue of triageIssues) {
    let group = map.get(issue.repository);
    if (!group) {
      group = [];
      map.set(issue.repository, group);
    }
    group.push(issue);
  }
  return map;
}
