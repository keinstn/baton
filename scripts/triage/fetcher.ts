import type { TrackerConfig } from "../../src/config/schema.js";
import { GitHubProjectsClient } from "../../src/tracker/github-projects.js";
import type { Issue } from "../../src/tracker/types.js";
import type { TrackerTriageConfig } from "./config.js";

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

export async function fetchAndGroup(
  config: TrackerTriageConfig,
  fetchFn?: typeof fetch,
): Promise<Map<string, Issue[]>> {
  const client = new GitHubProjectsClient(toTrackerConfig(config), fetchFn);
  const issues = await client.fetchIssuesByStates([config.todoState]);
  const map = new Map<string, Issue[]>();
  for (const issue of issues) {
    let group = map.get(issue.repository);
    if (!group) {
      group = [];
      map.set(issue.repository, group);
    }
    group.push(issue);
  }
  return map;
}
