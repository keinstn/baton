import { describe, expect, it } from "vitest";
import { startHttpServer } from "../src/observability/http.js";
import type {
  OrchestratorSnapshot,
  SnapshotRetrying,
  SnapshotRunning,
} from "../src/orchestrator/orchestrator.js";
import { silentLogger } from "./helpers.js";

function makeRunning(over: Partial<SnapshotRunning> = {}): SnapshotRunning {
  return {
    identifier: "repo-1",
    issue_id: "I_1",
    issue_url: "https://github.com/acme/repo/issues/1",
    title: "Test issue",
    state: "In Progress",
    turn_count: 2,
    session_id: "sess-1",
    started_at: "2026-06-11T00:00:00.000Z",
    last_event: "tool_use",
    last_event_at: "2026-06-11T00:01:00.000Z",
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    retry_attempt: null,
    failure_attempt: 0,
    ...over,
  };
}

function makeRetrying(over: Partial<SnapshotRetrying> = {}): SnapshotRetrying {
  return {
    identifier: "repo-2",
    issue_id: "I_2",
    issue_url: "https://github.com/acme/repo/issues/2",
    title: "Retry issue",
    attempt: 1,
    prompt_attempt: 1,
    scheduled_at: "2026-06-11T00:00:00.000Z",
    fires_at: "2026-06-11T00:00:30.000Z",
    delay_ms: 30000,
    ...over,
  };
}

function makeSnapshot(
  over: Partial<OrchestratorSnapshot> = {},
): OrchestratorSnapshot {
  return {
    generated_at: "2026-06-11T00:02:00.000Z",
    running: [makeRunning()],
    retrying: [makeRetrying()],
    agent_totals: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      seconds_running: 12.5,
    },
    rate_limits: null,
    ...over,
  };
}

interface TestServer {
  port: number;
  baseUrl: string;
  refreshCallCount(): number;
  setSnapshot(s: OrchestratorSnapshot): void;
  close(): Promise<void>;
}

async function startTestServer(
  initial: OrchestratorSnapshot = makeSnapshot(),
): Promise<TestServer> {
  let snap = initial;
  let refreshes = 0;
  const handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0, // ephemeral
    snapshot: () => snap,
    refresh: () => {
      refreshes += 1;
    },
    logger: silentLogger,
  });
  return {
    port: handle.port,
    baseUrl: `http://127.0.0.1:${handle.port}`,
    refreshCallCount: () => refreshes,
    setSnapshot: (s) => {
      snap = s;
    },
    close: () => handle.close(),
  };
}

describe("startHttpServer (SPEC §13.7)", () => {
  describe("GET /api/v1/state", () => {
    it("returns the full snapshot as JSON including rate_limits: null", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/state`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/application\/json/);
        const body = (await res.json()) as OrchestratorSnapshot;
        expect(body.running).toHaveLength(1);
        expect(body.running[0]?.identifier).toBe("repo-1");
        expect(body.retrying).toHaveLength(1);
        expect(body.agent_totals.total_tokens).toBe(150);
        // SPEC §13.5: rate_limits must be present (not absent) even when null.
        expect(Object.hasOwn(body, "rate_limits")).toBe(true);
        expect(body.rate_limits).toBe(null);
      } finally {
        await srv.close();
      }
    });

    it("HEAD /api/v1/state returns 200 with headers but no body", async () => {
      const srv = await startTestServer();
      try {
        const getRes = await fetch(`${srv.baseUrl}/api/v1/state`);
        const headRes = await fetch(`${srv.baseUrl}/api/v1/state`, {
          method: "HEAD",
        });
        expect(headRes.status).toBe(200);
        expect(headRes.headers.get("content-type")).toMatch(
          /application\/json/,
        );
        // Content-Length on HEAD must match the GET body length.
        expect(headRes.headers.get("content-length")).toBe(
          getRes.headers.get("content-length"),
        );
        // HEAD responses must have no body.
        expect(await headRes.text()).toBe("");
      } finally {
        await srv.close();
      }
    });

    it("rejects non-GET methods with 405 and Allow header", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/state`, {
          method: "DELETE",
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toContain("GET");
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("method_not_allowed");
      } finally {
        await srv.close();
      }
    });
  });

  describe("GET /api/v1/<identifier>", () => {
    it("returns the matching running entry", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/repo-1`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          identifier: string;
          running: SnapshotRunning;
          retrying: null;
        };
        expect(body.identifier).toBe("repo-1");
        expect(body.running.session_id).toBe("sess-1");
        expect(body.retrying).toBe(null);
      } finally {
        await srv.close();
      }
    });

    it("returns the matching retrying entry", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/repo-2`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          identifier: string;
          running: null;
          retrying: SnapshotRetrying;
        };
        expect(body.identifier).toBe("repo-2");
        expect(body.running).toBe(null);
        expect(body.retrying.attempt).toBe(1);
      } finally {
        await srv.close();
      }
    });

    it("returns 404 with not_found envelope when identifier is unknown", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/missing`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("not_found");
      } finally {
        await srv.close();
      }
    });

    it("URL-decodes the identifier path segment", async () => {
      const srv = await startTestServer(
        makeSnapshot({
          running: [makeRunning({ identifier: "repo with space-1" })],
        }),
      );
      try {
        const res = await fetch(
          `${srv.baseUrl}/api/v1/${encodeURIComponent("repo with space-1")}`,
        );
        expect(res.status).toBe(200);
      } finally {
        await srv.close();
      }
    });

    it("resolves owner_repo-N identifiers produced by the tracker", async () => {
      const srv = await startTestServer(
        makeSnapshot({
          running: [makeRunning({ identifier: "acme_my-repo-1" })],
        }),
      );
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/acme_my-repo-1`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { identifier: string };
        expect(body.identifier).toBe("acme_my-repo-1");
      } finally {
        await srv.close();
      }
    });
  });

  describe("POST /api/v1/refresh", () => {
    it("returns 202 immediately and triggers refresh", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/refresh`, {
          method: "POST",
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as { accepted: boolean };
        expect(body.accepted).toBe(true);
        expect(srv.refreshCallCount()).toBe(1);
      } finally {
        await srv.close();
      }
    });

    it("calls refresh once per request (coalescing is the caller's job)", async () => {
      // SPEC §13.7: coalescing is implemented in the trigger callback (cli.ts).
      // The HTTP handler MUST forward every successful POST so the trigger can
      // see them; verifying that here.
      const srv = await startTestServer();
      try {
        await Promise.all([
          fetch(`${srv.baseUrl}/api/v1/refresh`, { method: "POST" }),
          fetch(`${srv.baseUrl}/api/v1/refresh`, { method: "POST" }),
          fetch(`${srv.baseUrl}/api/v1/refresh`, { method: "POST" }),
        ]);
        expect(srv.refreshCallCount()).toBe(3);
      } finally {
        await srv.close();
      }
    });

    it("rejects GET on /api/v1/refresh with 405", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/api/v1/refresh`);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
      } finally {
        await srv.close();
      }
    });
  });

  describe("GET /", () => {
    it("returns HTML with auto-refresh meta and snapshot data", async () => {
      const srv = await startTestServer();
      try {
        const res = await fetch(`${srv.baseUrl}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        const html = await res.text();
        expect(html).toMatch(/<meta http-equiv="refresh" content="5">/);
        expect(html).toContain("repo-1");
        expect(html).toContain("Test issue");
        expect(html).toContain("repo-2");
      } finally {
        await srv.close();
      }
    });

    it("HEAD / returns 200 with Content-Length matching GET body and no body", async () => {
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

    it("escapes HTML in titles to prevent XSS", async () => {
      const srv = await startTestServer(
        makeSnapshot({
          running: [makeRunning({ title: "<script>alert('x')</script>" })],
        }),
      );
      try {
        const res = await fetch(`${srv.baseUrl}/`);
        const html = await res.text();
        expect(html).not.toContain("<script>alert");
        expect(html).toContain("&lt;script&gt;");
      } finally {
        await srv.close();
      }
    });

    it("renders empty-state placeholders when there are no rows", async () => {
      const srv = await startTestServer(
        makeSnapshot({ running: [], retrying: [] }),
      );
      try {
        const res = await fetch(`${srv.baseUrl}/`);
        const html = await res.text();
        expect(html).toContain("Running");
        expect(html).toContain("Retrying");
      } finally {
        await srv.close();
      }
    });

    it("strips non-http(s) URL schemes in issue_url to prevent javascript: links", async () => {
      const srv = await startTestServer(
        makeSnapshot({
          running: [makeRunning({ issue_url: "javascript:alert(1)" })],
          retrying: [
            makeRetrying({ issue_url: "data:text/html,<script>x</script>" }),
          ],
        }),
      );
      try {
        const res = await fetch(`${srv.baseUrl}/`);
        const html = await res.text();
        expect(html).not.toMatch(/href="javascript:/i);
        expect(html).not.toMatch(/href="data:/i);
        // Identifier should still appear, just not as a link.
        expect(html).toContain("repo-1");
        expect(html).toContain("repo-2");
      } finally {
        await srv.close();
      }
    });
  });

  describe("error envelope and routing", () => {
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

    it("returns 405 on GET / with PUT method", async () => {
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
        const res = await fetch(`${srv.baseUrl}/api/v1/state?foo=bar`);
        expect(res.status).toBe(200);
      } finally {
        await srv.close();
      }
    });

    it("returns 400 bad_request on malformed percent-encoding in identifier", async () => {
      const srv = await startTestServer();
      try {
        // Bypass fetch's URL normalization with a raw request.
        const res = await fetch(`${srv.baseUrl}/api/v1/%ZZ`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("bad_request");
      } finally {
        await srv.close();
      }
    });
  });
});
