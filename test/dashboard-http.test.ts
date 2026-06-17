import { describe, expect, it, vi } from "vitest";
import type { BoardState } from "../src/dashboard/config.js";
import { startDashboardServer } from "../src/dashboard/http.js";
import type { AggregatedTotals } from "../src/dashboard/poller.js";
import type { OrchestratorSnapshot } from "../src/orchestrator/orchestrator.js";
import { silentLogger } from "./helpers.js";

function makeSnapshot(
  over: Partial<OrchestratorSnapshot> = {},
): OrchestratorSnapshot {
  return {
    generated_at: "2026-06-17T00:00:00.000Z",
    running: [],
    retrying: [],
    agent_totals: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      seconds_running: 10,
    },
    rate_limits: null,
    ...over,
  };
}

function makeBoard(over: Partial<BoardState> = {}): BoardState {
  return {
    name: "alpha",
    url: "http://localhost:8001",
    up: true,
    lastScrapedAt: new Date("2026-06-17T00:00:00.000Z"),
    snapshot: makeSnapshot({
      running: [
        {
          identifier: "repo-1",
          issue_id: "I_1",
          issue_url: "https://github.com/acme/repo/issues/1",
          title: "Test issue alpha",
          state: "In Progress",
          turn_count: 2,
          session_id: "sess-1",
          started_at: "2026-06-17T00:00:00.000Z",
          last_event: "tool_use",
          last_event_at: "2026-06-17T00:01:00.000Z",
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          retry_attempt: null,
          failure_attempt: 0,
        },
      ],
    }),
    ...over,
  };
}

function makeTotals(over: Partial<AggregatedTotals> = {}): AggregatedTotals {
  return {
    running: 1,
    retrying: 0,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    seconds_running: 10,
    ...over,
  };
}

interface TestServer {
  port: number;
  baseUrl: string;
  setBoards(b: BoardState[]): void;
  setTotals(t: AggregatedTotals): void;
  close(): Promise<void>;
}

async function startTestServer(opts?: {
  boards?: BoardState[];
  totals?: AggregatedTotals;
  fetch?: typeof globalThis.fetch;
}): Promise<TestServer> {
  let boards: BoardState[] = opts?.boards ?? [makeBoard()];
  let totals: AggregatedTotals = opts?.totals ?? makeTotals();

  const handle = await startDashboardServer({
    host: "127.0.0.1",
    port: 0,
    boards: () => boards,
    totals: () => totals,
    fetch: opts?.fetch,
    logger: silentLogger,
  });

  return {
    port: handle.port,
    baseUrl: `http://127.0.0.1:${handle.port}`,
    setBoards: (b) => {
      boards = b;
    },
    setTotals: (t) => {
      totals = t;
    },
    close: () => handle.close(),
  };
}

describe("startDashboardServer — GET /", () => {
  it("returns HTML with auto-refresh meta, board names, and totals", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toMatch(/<meta http-equiv="refresh" content="5">/);
      expect(html).toContain("alpha");
      expect(html).toContain("Test issue alpha");
      expect(html).toContain("repo-1");
    } finally {
      await srv.close();
    }
  });

  it("shows UP badge for up boards and DOWN badge for down boards", async () => {
    const boards = [
      makeBoard({ name: "up-board", up: true }),
      makeBoard({
        name: "down-board",
        url: "http://localhost:8002",
        up: false,
        snapshot: undefined,
        error: "connection refused",
      }),
    ];
    const srv = await startTestServer({ boards });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      const html = await res.text();
      expect(html).toContain("UP");
      expect(html).toContain("DOWN");
      expect(html).toContain("up-board");
      expect(html).toContain("down-board");
    } finally {
      await srv.close();
    }
  });

  it("shows aggregated totals in the stats grid", async () => {
    const srv = await startTestServer({
      totals: makeTotals({
        running: 3,
        retrying: 2,
        total_tokens: 9999,
        seconds_running: 42.5,
      }),
    });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      const html = await res.text();
      expect(html).toContain("9999");
      expect(html).toContain("42.5");
    } finally {
      await srv.close();
    }
  });

  it("renders empty-state placeholders when boards have no running/retrying rows", async () => {
    const srv = await startTestServer({
      boards: [makeBoard({ snapshot: makeSnapshot() })],
    });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      const html = await res.text();
      expect(html).toContain("Running");
      expect(html).toContain("Retrying");
      expect(html).toContain("none");
    } finally {
      await srv.close();
    }
  });

  it("escapes HTML in issue titles to prevent XSS", async () => {
    const boards = [
      makeBoard({
        snapshot: makeSnapshot({
          running: [
            {
              identifier: "repo-xss",
              issue_id: "I_xss",
              issue_url: null,
              title: "<script>alert('xss')</script>",
              state: null,
              turn_count: 0,
              session_id: null,
              started_at: "2026-06-17T00:00:00.000Z",
              last_event: null,
              last_event_at: null,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              retry_attempt: null,
              failure_attempt: 0,
            },
          ],
        }),
      }),
    ];
    const srv = await startTestServer({ boards });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      const html = await res.text();
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      await srv.close();
    }
  });

  it("renders board as down/empty when snapshot has unexpected shape", async () => {
    const boards = [
      makeBoard({ name: "malformed", snapshot: { not_running: "oops" } }),
    ];
    const srv = await startTestServer({ boards });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("malformed");
      expect(html).toContain("none");
    } finally {
      await srv.close();
    }
  });

  it("filters out invalid running entries so GET / does not crash when snapshot contains null elements", async () => {
    const boards = [
      makeBoard({
        name: "partial",
        snapshot: { running: [null, { not_identifier: true }], retrying: [] },
      }),
    ];
    const srv = await startTestServer({ boards });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("partial");
      expect(html).toContain("none");
    } finally {
      await srv.close();
    }
  });

  it("normalizes running entries with non-string state/session_id/last_event so GET / does not crash", async () => {
    const boards = [
      makeBoard({
        name: "badfields",
        snapshot: {
          running: [
            {
              identifier: "repo-bad",
              title: "Bad fields",
              started_at: "2026-06-17T00:00:00.000Z",
              state: { bad: true },
              session_id: { also: "bad" },
              last_event: [1, 2, 3],
            },
          ],
          retrying: [],
        },
      }),
    ];
    const srv = await startTestServer({ boards });
    try {
      const res = await fetch(`${srv.baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("badfields");
      expect(html).toContain("repo-bad");
    } finally {
      await srv.close();
    }
  });

  it("HEAD / returns 200 with Content-Length matching GET and no body", async () => {
    const srv = await startTestServer();
    try {
      const getRes = await fetch(`${srv.baseUrl}/`);
      const headRes = await fetch(`${srv.baseUrl}/`, { method: "HEAD" });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-type")).toMatch(/text\/html/);
      expect(headRes.headers.get("content-length")).toBe(
        getRes.headers.get("content-length"),
      );
      expect(await headRes.text()).toBe("");
    } finally {
      await srv.close();
    }
  });
});

describe("startDashboardServer — GET /api/v1/boards", () => {
  it("returns all boards as a JSON array", async () => {
    const boards = [
      makeBoard({ name: "alpha" }),
      makeBoard({ name: "beta", url: "http://localhost:8002" }),
    ];
    const srv = await startTestServer({ boards });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await res.json()) as BoardState[];
      expect(body).toHaveLength(2);
      expect(body[0]?.name).toBe("alpha");
      expect(body[1]?.name).toBe("beta");
    } finally {
      await srv.close();
    }
  });

  it("HEAD /api/v1/boards returns 200 with no body", async () => {
    const srv = await startTestServer();
    try {
      const headRes = await fetch(`${srv.baseUrl}/api/v1/boards`, {
        method: "HEAD",
      });
      expect(headRes.status).toBe(200);
      expect(await headRes.text()).toBe("");
    } finally {
      await srv.close();
    }
  });

  it("rejects non-GET methods with 405", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards`, {
        method: "DELETE",
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("method_not_allowed");
    } finally {
      await srv.close();
    }
  });
});

describe("startDashboardServer — GET /api/v1/boards/<name>/state", () => {
  it("returns the cached snapshot for a known board", async () => {
    const srv = await startTestServer({
      boards: [makeBoard({ name: "alpha", up: true })],
    });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/state`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await res.json()) as BoardState;
      expect(body.name).toBe("alpha");
      expect(body.up).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("returns 404 for an unknown board name", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(
        `${srv.baseUrl}/api/v1/boards/no-such-board/state`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    } finally {
      await srv.close();
    }
  });

  it("URL-decodes the board name in the path", async () => {
    const srv = await startTestServer({
      boards: [makeBoard({ name: "my board" })],
    });
    try {
      const res = await fetch(
        `${srv.baseUrl}/api/v1/boards/${encodeURIComponent("my board")}/state`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as BoardState;
      expect(body.name).toBe("my board");
    } finally {
      await srv.close();
    }
  });

  it("HEAD returns 200 with no body for a known board", async () => {
    const srv = await startTestServer();
    try {
      const headRes = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/state`, {
        method: "HEAD",
      });
      expect(headRes.status).toBe(200);
      expect(await headRes.text()).toBe("");
    } finally {
      await srv.close();
    }
  });

  it("rejects non-GET methods with 405", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/state`, {
        method: "POST",
      });
      expect(res.status).toBe(405);
    } finally {
      await srv.close();
    }
  });
});

describe("startDashboardServer — POST /api/v1/boards/<name>/refresh", () => {
  it("proxies to the board's refresh endpoint and returns 202", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({ fetch: mockFetch });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:8001/api/v1/refresh");
      expect(init.method).toBe("POST");
    } finally {
      await srv.close();
    }
  });

  it("returns 404 for an unknown board name", async () => {
    const mockFetch = vi.fn() as unknown as typeof globalThis.fetch;
    const srv = await startTestServer({ fetch: mockFetch });
    try {
      const res = await fetch(
        `${srv.baseUrl}/api/v1/boards/no-such-board/refresh`,
        { method: "POST" },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it("returns 502 when the upstream refresh fails with a network error", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({ fetch: mockFetch });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("bad_gateway");
      expect(body.error.message).toContain("ECONNREFUSED");
    } finally {
      await srv.close();
    }
  });

  it("returns 502 when the upstream returns a non-2xx status", async () => {
    const mockFetch = vi.fn(
      async () => new Response(null, { status: 503 }),
    ) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({ fetch: mockFetch });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("bad_gateway");
      expect(body.error.message).toContain("503");
    } finally {
      await srv.close();
    }
  });

  it("rejects GET on a refresh path with 405", async () => {
    const mockFetch = vi.fn() as unknown as typeof globalThis.fetch;
    const srv = await startTestServer({ fetch: mockFetch });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it("returns 504 when the upstream fetch is aborted (timeout)", async () => {
    const mockFetch = vi.fn(async () => {
      const err = Object.assign(new Error("The operation was aborted."), {
        name: "AbortError",
      });
      throw err;
    }) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({ fetch: mockFetch });
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("gateway_timeout");
    } finally {
      await srv.close();
    }
  });

  it("trailing slash on board.url does not produce a double slash in the proxied URL", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({
      boards: [makeBoard({ url: "http://localhost:8001/" })],
      fetch: mockFetch,
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
      ];
      expect(url).toBe("http://localhost:8001/api/v1/refresh");
    } finally {
      await srv.close();
    }
  });

  it("does not corrupt the refresh URL when board.url contains a query string", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({
      boards: [makeBoard({ url: "http://localhost:8001/prefix?token=abc" })],
      fetch: mockFetch,
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
      ];
      // query string must not appear in the middle of the path
      expect(url).toBe("http://localhost:8001/prefix/api/v1/refresh?token=abc");
    } finally {
      await srv.close();
    }
  });

  it("preserves base path in board.url when constructing the proxied refresh URL", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    const srv = await startTestServer({
      boards: [makeBoard({ url: "http://localhost:8001/prefix" })],
      fetch: mockFetch,
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/boards/alpha/refresh`, {
        method: "POST",
      });
      const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
      ];
      expect(url).toBe("http://localhost:8001/prefix/api/v1/refresh");
    } finally {
      await srv.close();
    }
  });
});

describe("startDashboardServer — error envelope and routing", () => {
  it("returns 404 with JSON envelope on unknown paths", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/api/v2/unknown`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toMatch(/no resource at/);
    } finally {
      await srv.close();
    }
  });

  it("returns 405 on PUT /", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/`, { method: "PUT" });
      expect(res.status).toBe(405);
    } finally {
      await srv.close();
    }
  });

  it("ignores query strings when matching paths", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards?foo=bar`);
      expect(res.status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("returns 405 on DELETE /api/v1/boards/<name>/state", async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.baseUrl}/api/v1/boards/alpha/state`, {
        method: "DELETE",
      });
      expect(res.status).toBe(405);
    } finally {
      await srv.close();
    }
  });
});
