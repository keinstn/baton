import { describe, expect, it, vi } from "vitest";
import type { TrackerTriageConfig } from "../scripts/triage/config.js";
import { fetchAndGroup } from "../scripts/triage/fetcher.js";

function baseConfig(
  overrides: Partial<TrackerTriageConfig> = {},
): TrackerTriageConfig {
  return {
    token: "test-token",
    endpoint: "https://api.github.com/graphql",
    owner: "acme",
    ownerType: "organization",
    projectNumber: 1,
    statusField: "Status",
    todoState: "Todo",
    aiReadyLabel: "ai-ready",
    repos: null,
    ...overrides,
  };
}

function gqlResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

function restResponse(subIssues: unknown[] = []): Response {
  return {
    ok: true,
    status: 200,
    json: async () => subIssues,
  } as unknown as Response;
}

function restError(status = 404): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message: "Not Found" }),
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
              { name: "Done" },
            ],
          },
        ],
      },
    },
  },
};

function item(num: number, repo: string, status = "Todo") {
  const [, repoName] = repo.split("/");
  return {
    id: `PVTI_${num}`,
    fieldValues: {
      nodes: [{ name: status, field: { name: "Status" } }],
    },
    content: {
      __typename: "Issue",
      id: `I_${num}`,
      number: num,
      title: `Issue ${num}`,
      body: "body",
      url: `https://github.com/${repo}/issues/${num}`,
      state: "OPEN",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: null,
      labels: { nodes: [] },
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

function mockFetch(responses: Response[]): typeof fetch {
  const fn = vi.fn();
  for (const res of responses) fn.mockResolvedValueOnce(res);
  return fn as unknown as typeof fetch;
}

describe("fetchAndGroup", () => {
  it("returns an empty Map when the board has no Todo issues", async () => {
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([], null, false)),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    expect(result.size).toBe(0);
  });

  it("groups issues by owner/repo", async () => {
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(
        itemsPage(
          [item(1, "acme/alpha"), item(2, "acme/beta"), item(3, "acme/alpha")],
          null,
          false,
        ),
      ),
      restResponse(),
      restResponse(),
      restResponse(),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    expect([...result.keys()].sort()).toEqual(["acme/alpha", "acme/beta"]);
    expect(result.get("acme/alpha")?.map((i) => i.number)).toEqual([1, 3]);
    expect(result.get("acme/beta")?.map((i) => i.number)).toEqual([2]);
  });

  it("only includes issues in the todoState", async () => {
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(
        itemsPage(
          [item(1, "acme/repo", "Todo"), item(2, "acme/repo", "In Progress")],
          null,
          false,
        ),
      ),
      restResponse(),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    expect(result.get("acme/repo")?.map((i) => i.number)).toEqual([1]);
  });

  it("forwards repos filter to the client", async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(gqlResponse(PROJECT_DATA));
    fn.mockResolvedValueOnce(
      gqlResponse(
        itemsPage([item(1, "acme/alpha"), item(2, "acme/beta")], null, false),
      ),
    );
    fn.mockResolvedValueOnce(restResponse());
    const result = await fetchAndGroup(
      baseConfig({ repos: ["acme/alpha"] }),
      fn as unknown as typeof fetch,
    );
    expect([...result.keys()]).toEqual(["acme/alpha"]);
    expect(result.has("acme/beta")).toBe(false);
  });

  it("handles a single repo with multiple issues", async () => {
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(
        itemsPage(
          [item(10, "acme/monorepo"), item(20, "acme/monorepo")],
          null,
          false,
        ),
      ),
      restResponse(),
      restResponse(),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    expect(result.size).toBe(1);
    expect(result.get("acme/monorepo")?.map((i) => i.number)).toEqual([10, 20]);
  });

  it("attaches openSubIssues from REST response", async () => {
    const subIssues = [
      {
        number: 10,
        title: "Sub A",
        html_url: "https://github.com/acme/repo/issues/10",
        state: "open",
      },
      {
        number: 11,
        title: "Sub B",
        html_url: "https://github.com/acme/repo/issues/11",
        state: "open",
      },
    ];
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([item(1, "acme/repo")], null, false)),
      restResponse(subIssues),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    const issues = result.get("acme/repo");
    expect(issues).toHaveLength(1);
    expect(issues?.[0]?.openSubIssues).toEqual([
      {
        number: 10,
        title: "Sub A",
        url: "https://github.com/acme/repo/issues/10",
      },
      {
        number: 11,
        title: "Sub B",
        url: "https://github.com/acme/repo/issues/11",
      },
    ]);
  });

  it("excludes closed sub-issues from openSubIssues", async () => {
    const subIssues = [
      {
        number: 10,
        title: "Open sub",
        html_url: "https://github.com/acme/repo/issues/10",
        state: "open",
      },
      {
        number: 11,
        title: "Closed sub",
        html_url: "https://github.com/acme/repo/issues/11",
        state: "closed",
      },
    ];
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([item(1, "acme/repo")], null, false)),
      restResponse(subIssues),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    const issues = result.get("acme/repo");
    expect(issues?.[0]?.openSubIssues).toEqual([
      {
        number: 10,
        title: "Open sub",
        url: "https://github.com/acme/repo/issues/10",
      },
    ]);
  });

  it("returns empty openSubIssues when REST returns an error", async () => {
    const fetch = mockFetch([
      gqlResponse(PROJECT_DATA),
      gqlResponse(itemsPage([item(1, "acme/repo")], null, false)),
      restError(404),
    ]);
    const result = await fetchAndGroup(baseConfig(), fetch);
    const issues = result.get("acme/repo");
    expect(issues?.[0]?.openSubIssues).toEqual([]);
  });

  it("passes the token in the Authorization header for sub-issues requests", async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(gqlResponse(PROJECT_DATA));
    fn.mockResolvedValueOnce(
      gqlResponse(itemsPage([item(1, "acme/repo")], null, false)),
    );
    fn.mockResolvedValueOnce(restResponse());
    await fetchAndGroup(
      baseConfig({ token: "my-token" }),
      fn as unknown as typeof fetch,
    );

    const calls = fn.mock.calls;
    // The last call is the sub-issues REST request
    const restCall = calls.find(
      ([url]: [string]) =>
        typeof url === "string" && url.includes("/sub_issues"),
    );
    expect(restCall?.[1]?.headers?.Authorization).toBe("Bearer my-token");
  });
});
