import { describe, expect, it, vi } from "vitest";
import type { TrackerConfig } from "../src/config/schema.js";
import { GitHubProjectsClient } from "../src/tracker/github-projects.js";
import { makeConfig } from "./helpers.js";

function trackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return { ...makeConfig().tracker, ...overrides };
}

function gqlResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

const PROJECT_DATA = {
  organization: {
    projectV2: {
      id: "PVT_1",
      fields: {
        nodes: [
          {
            name: "Status",
            options: [
              { name: "Todo" },
              { name: "In Progress" },
              { name: "In Review" },
              { name: "Done" },
            ],
          },
          {
            name: "Priority",
            options: [{ name: "P0" }, { name: "P1" }, { name: "P2" }],
          },
          {},
        ],
      },
    },
  },
};

interface ItemOpts {
  repo?: string;
  labels?: string[];
  typename?: string;
  closed?: boolean;
  priority?: string;
  createdAt?: string;
  status?: string | null;
}

function item(num: number, status: string | null, opts: ItemOpts = {}) {
  const repo = opts.repo ?? "acme/repo";
  const [, repoName] = repo.split("/");
  return {
    id: `PVTI_${num}`,
    fieldValues: {
      nodes: [
        ...(status !== null
          ? [{ name: status, field: { name: "Status" } }]
          : []),
        ...(opts.priority
          ? [{ name: opts.priority, field: { name: "Priority" } }]
          : []),
        {},
      ],
    },
    content: {
      __typename: opts.typename ?? "Issue",
      id: `I_${num}`,
      number: num,
      title: `Issue ${num}`,
      body: "body",
      url: `https://github.com/${repo}/issues/${num}`,
      state: opts.closed ? "CLOSED" : "OPEN",
      createdAt: opts.createdAt ?? "2026-01-01T00:00:00Z",
      updatedAt: null,
      labels: { nodes: (opts.labels ?? []).map((name) => ({ name })) },
      repository: { name: repoName, nameWithOwner: repo },
    },
  };
}

function itemsPage(
  nodes: unknown[],
  endCursor: string | null,
  hasNextPage: boolean,
) {
  return { node: { items: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

function client(
  responses: Response[],
  cfg: TrackerConfig = trackerConfig(),
): { client: GitHubProjectsClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  for (const res of responses) fetchMock.mockResolvedValueOnce(res);
  return {
    client: new GitHubProjectsClient(cfg, fetchMock as unknown as typeof fetch),
    fetchMock,
  };
}

function sentQuery(fetchMock: ReturnType<typeof vi.fn>, call: number): string {
  const init = fetchMock.mock.calls[call]?.[1] as { body: string };
  return (JSON.parse(init.body) as { query: string }).query;
}

describe("project resolution (SPEC §11.2)", () => {
  it("resolves the project once and caches field metadata", async () => {
    const { client: c, fetchMock } = client([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([item(1, "Todo")], null, false)),
      gqlResponse(itemsPage([item(1, "Todo")], null, false)),
    ]);
    await c.fetchCandidateIssues();
    await c.fetchCandidateIssues();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentQuery(fetchMock, 0)).toContain("BatonProject");
    expect(sentQuery(fetchMock, 1)).toContain("BatonItems");
    expect(sentQuery(fetchMock, 2)).toContain("BatonItems");
  });

  it("honors owner_type user", async () => {
    const userData = { user: PROJECT_DATA.organization };
    const { client: c, fetchMock } = client(
      [gqlResponse(userData), gqlResponse(itemsPage([], null, false))],
      trackerConfig({ ownerType: "user" }),
    );
    await c.fetchCandidateIssues();
    expect(sentQuery(fetchMock, 0)).toContain("user(login: $owner)");
  });

  it("fails with missing_tracker_project when the project is absent", async () => {
    const { client: c } = client([
      gqlResponse({ organization: { projectV2: null } }),
    ]);
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "missing_tracker_project",
    });
  });

  it("fails with missing_status_field when the status field is absent", async () => {
    const { client: c } = client(
      [gqlResponse(PROJECT_DATA)],
      trackerConfig({ statusField: "Stage" }),
    );
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "missing_status_field",
    });
  });

  it("fails with missing_tracker_token when no token is configured", async () => {
    const { client: c, fetchMock } = client([], trackerConfig({ token: null }));
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "missing_tracker_token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applyConfig swaps tracker config and invalidates the project cache (SPEC §6.2)", async () => {
    const { client: c, fetchMock } = client([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([], null, false)),
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([], null, false)),
    ]);
    await c.fetchCandidateIssues(); // resolves project for owner "acme"
    c.applyConfig(trackerConfig({ owner: "newcorp" }));
    await c.fetchCandidateIssues(); // must re-resolve after cache invalidation

    expect(sentQuery(fetchMock, 0)).toContain("BatonProject");
    expect(sentQuery(fetchMock, 2)).toContain("BatonProject");
    const reresolve = fetchMock.mock.calls[2]?.[1] as { body: string };
    const vars = (
      JSON.parse(reresolve.body) as { variables: { owner: string } }
    ).variables;
    expect(vars.owner).toBe("newcorp");
  });
});

describe("candidate fetch and normalization (SPEC §11.2-11.3)", () => {
  it("paginates and preserves order across pages", async () => {
    const { client: c } = client([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([item(1, "Todo"), item(2, "Todo")], "c1", true)),
      gqlResponse(itemsPage([item(3, "In Progress")], null, false)),
    ]);
    const issues = await c.fetchCandidateIssues();
    expect(issues.map((i) => i.identifier)).toEqual([
      "repo-1",
      "repo-2",
      "repo-3",
    ]);
  });

  it("filters by status, drops non-issues, and applies the repos filter", async () => {
    const cfg = trackerConfig({ repos: ["acme/repo"] });
    const { client: c } = client(
      [
        gqlResponse(PROJECT_DATA),
        gqlResponse(
          itemsPage(
            [
              item(1, "Todo"),
              item(2, "Done"),
              item(3, "Todo", { typename: "PullRequest" }),
              item(4, "Todo", { repo: "acme/other" }),
              item(5, null),
            ],
            null,
            false,
          ),
        ),
      ],
      cfg,
    );
    const issues = await c.fetchCandidateIssues();
    expect(issues.map((i) => i.identifier)).toEqual(["repo-1"]);
  });

  it("normalizes labels to lowercase, derives priority position, and flags closed issues", async () => {
    const { client: c } = client(
      [
        gqlResponse(PROJECT_DATA),
        gqlResponse(
          itemsPage(
            [
              item(1, "Todo", {
                labels: [" Bug ", "AI-Ready"],
                priority: "P1",
                closed: true,
              }),
            ],
            null,
            false,
          ),
        ),
      ],
      trackerConfig({ priorityField: "Priority" }),
    );
    const issues = await c.fetchCandidateIssues();
    const issue = issues[0]!;
    expect(issue.labels).toEqual(["bug", "ai-ready"]);
    expect(issue.priority).toBe(2);
    expect(issue.closed).toBe(true);
    expect(issue.repository).toBe("acme/repo");
    expect(issue.identifier).toBe("repo-1");
    expect(issue.blockedBy).toEqual([]);
  });

  it("treats hasNextPage without endCursor as a pagination integrity error", async () => {
    const { client: c } = client([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([item(1, "Todo")], null, true)),
    ]);
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "github_missing_end_cursor",
    });
  });

  it("fetchIssuesByStates([]) returns empty without an API call", async () => {
    const { client: c, fetchMock } = client([]);
    expect(await c.fetchIssuesByStates([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("error mapping (SPEC §11.4)", () => {
  it("maps non-200 responses to github_api_status", async () => {
    const res = {
      ok: false,
      status: 502,
      json: async () => ({}),
    } as unknown as Response;
    const { client: c } = client([res]);
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "github_api_status",
    });
  });

  it("maps GraphQL errors to github_graphql_errors", async () => {
    const res = {
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "bad" }] }),
    } as unknown as Response;
    const { client: c } = client([res]);
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "github_graphql_errors",
    });
  });

  it("maps transport failures to github_api_request", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const c = new GitHubProjectsClient(
      trackerConfig(),
      fetchMock as unknown as typeof fetch,
    );
    await expect(c.fetchCandidateIssues()).rejects.toMatchObject({
      code: "github_api_request",
    });
  });
});

describe("issue state refresh (SPEC §11.1 op 3)", () => {
  it("resolves the Status via the configured project's item", async () => {
    const nodesData = {
      nodes: [
        {
          __typename: "Issue",
          id: "I_1",
          number: 1,
          title: "Issue 1",
          body: "body",
          url: "https://github.com/acme/repo/issues/1",
          state: "OPEN",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: null,
          labels: { nodes: [{ name: "AI-Ready" }] },
          repository: { name: "repo", nameWithOwner: "acme/repo" },
          projectItems: {
            nodes: [
              {
                id: "PVTI_other",
                project: { id: "PVT_other" },
                fieldValues: {
                  nodes: [{ name: "Done", field: { name: "Status" } }],
                },
              },
              {
                id: "PVTI_1",
                project: { id: "PVT_1" },
                fieldValues: {
                  nodes: [{ name: "In Progress", field: { name: "Status" } }],
                },
              },
            ],
          },
        },
        null,
      ],
    };
    const { client: c, fetchMock } = client([
      gqlResponse(PROJECT_DATA),
      gqlResponse(nodesData),
    ]);
    const issues = await c.fetchIssueStatesByIds(["I_1"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.state).toBe("In Progress");
    expect(issues[0]!.itemId).toBe("PVTI_1");
    expect(issues[0]!.labels).toEqual(["ai-ready"]);
    expect(sentQuery(fetchMock, 1)).toContain("$ids: [ID!]!");
  });

  it("returns empty for an empty ID list without an API call", async () => {
    const { client: c, fetchMock } = client([]);
    expect(await c.fetchIssueStatesByIds([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
