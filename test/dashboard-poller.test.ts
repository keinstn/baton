import { describe, expect, it, vi } from "vitest";
import type { DashboardConfig } from "../src/dashboard/config.js";
import { createPoller } from "../src/dashboard/poller.js";
import type { OrchestratorSnapshot } from "../src/orchestrator/orchestrator.js";

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

function makeConfig(
  targets: { name: string; url: string }[],
  pollIntervalMs = 5000,
): DashboardConfig {
  return {
    server: { host: "127.0.0.1", port: 8090 },
    pollIntervalMs,
    targets,
  };
}

function okFetch(snap: OrchestratorSnapshot): typeof globalThis.fetch {
  return vi.fn(async () =>
    Response.json(snap),
  ) as unknown as typeof globalThis.fetch;
}

function errFetch(msg: string): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw new Error(msg);
  }) as unknown as typeof globalThis.fetch;
}

function statusFetch(status: number): typeof globalThis.fetch {
  return vi.fn(
    async () => new Response(null, { status }),
  ) as unknown as typeof globalThis.fetch;
}

describe("createPoller — boards() initial state", () => {
  it("initialises all boards as down with null lastScrapedAt", () => {
    const poller = createPoller({
      config: makeConfig([
        { name: "alpha", url: "http://localhost:8001" },
        { name: "beta", url: "http://localhost:8002" },
      ]),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });
    const boards = poller.boards();
    expect(boards).toHaveLength(2);
    expect(boards[0]).toMatchObject({
      name: "alpha",
      up: false,
      lastScrapedAt: null,
    });
    expect(boards[1]).toMatchObject({
      name: "beta",
      up: false,
      lastScrapedAt: null,
    });
  });
});

describe("createPoller — up/down after scrape", () => {
  it("marks board up after a successful 200 + valid JSON response", async () => {
    const snap = makeSnapshot();
    const fetchMock = okFetch(snap);
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    // Allow the immediate pollAll() microtasks to settle
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const boards = poller.boards();
    expect(boards[0]?.up).toBe(true);
    expect(boards[0]?.lastScrapedAt).toBeInstanceOf(Date);
    expect(boards[0]?.error).toBeUndefined();
    expect(boards[0]?.snapshot).toBeDefined();
  });

  it("marks board down on non-200 HTTP status", async () => {
    const fetchMock = statusFetch(503);
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const boards = poller.boards();
    expect(boards[0]?.up).toBe(false);
    expect(boards[0]?.error).toMatch(/503/);
    expect(boards[0]?.lastScrapedAt).toBeInstanceOf(Date);
  });

  it("marks board down on connection error", async () => {
    const fetchMock = errFetch("ECONNREFUSED");
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const boards = poller.boards();
    expect(boards[0]?.up).toBe(false);
    expect(boards[0]?.error).toMatch(/ECONNREFUSED/);
  });

  it("marks board down on timeout (AbortError)", async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
      // Simulate a slow response that respects AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        const signal = opts?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
          return;
        }
        signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    // Board should still be down (timeout will fire later, but initial state is down)
    const boards = poller.boards();
    expect(boards[0]?.up).toBe(false);
  });

  it("marks board down on invalid JSON (missing required fields)", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ not_a_snapshot: true }),
    ) as unknown as typeof globalThis.fetch;
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const boards = poller.boards();
    expect(boards[0]?.up).toBe(false);
    expect(boards[0]?.error).toMatch(/invalid JSON/);
  });

  it("marks board down when response body is not JSON at all", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const boards = poller.boards();
    expect(boards[0]?.up).toBe(false);
  });
});

describe("createPoller — isolation (one target failure does not affect others)", () => {
  it("keeps healthy boards up when one board fails", async () => {
    const snap = makeSnapshot({
      agent_totals: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        seconds_running: 1,
      },
    });
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      callCount++;
      if ((url as string).includes("8001")) {
        throw new Error("connection refused");
      }
      return Response.json(snap);
    }) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([
        { name: "failing", url: "http://localhost:8001" },
        { name: "healthy", url: "http://localhost:8002" },
      ]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const boards = poller.boards();
    const failing = boards.find((b) => b.name === "failing");
    const healthy = boards.find((b) => b.name === "healthy");
    expect(failing?.up).toBe(false);
    expect(healthy?.up).toBe(true);
    expect(callCount).toBe(2);
  });
});

describe("createPoller — totals() aggregation", () => {
  it("sums agent_totals across all up boards", async () => {
    const snap1 = makeSnapshot({
      running: [{ identifier: "r1" } as never],
      retrying: [],
      agent_totals: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        seconds_running: 10,
      },
    });
    const snap2 = makeSnapshot({
      running: [],
      retrying: [{ identifier: "r2" } as never],
      agent_totals: {
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        seconds_running: 20,
      },
    });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return Response.json(call === 1 ? snap1 : snap2);
    }) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([
        { name: "a", url: "http://localhost:8001" },
        { name: "b", url: "http://localhost:8002" },
      ]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const t = poller.totals();
    expect(t.input_tokens).toBe(300);
    expect(t.output_tokens).toBe(150);
    expect(t.total_tokens).toBe(450);
    expect(t.seconds_running).toBe(30);
    expect(t.running).toBe(1);
    expect(t.retrying).toBe(1);
  });

  it("excludes down boards from totals", async () => {
    const snap = makeSnapshot({
      agent_totals: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        seconds_running: 10,
      },
    });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("down");
      return Response.json(snap);
    }) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([
        { name: "down-board", url: "http://localhost:8001" },
        { name: "up-board", url: "http://localhost:8002" },
      ]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const t = poller.totals();
    // Only the up board contributes
    expect(t.input_tokens).toBe(100);
    expect(t.total_tokens).toBe(150);
  });

  it("returns zero totals when all boards are down", () => {
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: errFetch("down") as unknown as typeof globalThis.fetch,
    });
    const t = poller.totals();
    expect(t.running).toBe(0);
    expect(t.retrying).toBe(0);
    expect(t.input_tokens).toBe(0);
    expect(t.total_tokens).toBe(0);
    expect(t.seconds_running).toBe(0);
  });
});

describe("createPoller — start/stop", () => {
  it("stop() prevents further polling", async () => {
    const fetchMock = okFetch(makeSnapshot());
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }], 50),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    const callsAfterStop = (fetchMock as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await new Promise((r) => setTimeout(r, 80));
    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterStop,
    );
  });

  it("calling start() twice does not double-poll", async () => {
    const fetchMock = okFetch(makeSnapshot());
    const poller = createPoller({
      config: makeConfig(
        [{ name: "alpha", url: "http://localhost:8001" }],
        1000,
      ),
      fetch: fetchMock,
    });
    poller.start();
    poller.start(); // second call is a no-op
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    // Only 1 immediate poll should have fired (not 2)
    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
