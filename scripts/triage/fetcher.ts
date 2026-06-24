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

async function fetchOpenSubIssues(
  restBase: string,
  token: string | null,
  owner: string,
  repo: string,
  issueNumber: number,
  fetchFn: typeof fetch,
): Promise<SubIssueRef[]> {
  const url = `${restBase}/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetchFn(url, { headers });
  if (!resp.ok) {
    return [];
  }
  const data: unknown = await resp.json();
  if (!Array.isArray(data)) return [];
  const result: SubIssueRef[] = [];
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
      s.state === "open"
    ) {
      result.push({ number: s.number, title: s.title, url: s.html_url });
    }
  }
  return result;
}

export async function fetchAndGroup(
  config: TrackerTriageConfig,
  fetchFn?: typeof fetch,
): Promise<Map<string, TriageIssue[]>> {
  const fn = fetchFn ?? globalThis.fetch;
  const client = new GitHubProjectsClient(toTrackerConfig(config), fn);
  const issues = await client.fetchIssuesByStates([config.todoState]);

  const restBase = config.endpoint.replace(/\/graphql$/, "");

  const triageIssues = await Promise.all(
    issues.map(async (issue): Promise<TriageIssue> => {
      const parts = issue.repository.split("/");
      const owner = parts[0] ?? "";
      const repo = parts[1] ?? "";
      const openSubIssues = await fetchOpenSubIssues(
        restBase,
        config.token,
        owner,
        repo,
        issue.number,
        fn,
      );
      return { ...issue, openSubIssues };
    }),
  );

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
