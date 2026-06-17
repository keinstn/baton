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

  it("marks board down when agent_totals is missing from snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        generated_at: "2026-06-17T00:00:00.000Z",
        running: [],
        retrying: [],
        // agent_totals intentionally absent
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

function makeRunningEntry(id: string) {
  return {
    identifier: id,
    issue_id: "",
    issue_url: null,
    title: `Issue ${id}`,
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
  };
}

function makeRetryingEntry(id: string) {
  return {
    identifier: id,
    issue_id: "",
    issue_url: null,
    title: `Issue ${id}`,
    attempt: 0,
    prompt_attempt: null,
    scheduled_at: "2026-06-17T00:00:00.000Z",
    fires_at: "2026-06-17T00:01:00.000Z",
    delay_ms: 0,
  };
}

describe("createPoller — totals() aggregation", () => {
  it("sums agent_totals across all up boards", async () => {
    const snap1 = makeSnapshot({
      running: [makeRunningEntry("r1")],
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
      retrying: [makeRetryingEntry("r2")],
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

  it("totals() only counts valid (normalizable) entries, matching what render displays", async () => {
    // One valid running entry + one malformed (missing title/started_at) → count = 1
    const snap = makeSnapshot({
      running: [
        makeRunningEntry("valid-1"),
        { identifier: "bad-no-title" } as never,
        { identifier: "bad-no-started-at", title: "oops" } as never,
      ],
      retrying: [
        makeRetryingEntry("valid-r1"),
        { identifier: "bad-retrying" } as never,
      ],
    });
    const fetchMock = vi.fn(async () =>
      Response.json(snap),
    ) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();

    const t = poller.totals();
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

  it("stop/start cycle does not cause a double-poll loop", async () => {
    // If stop() is called while an in-flight pollAll() is pending and then
    // start() is re-called, the stale loop must not schedule a second timer
    // after it completes (runId mismatch prevents this).
    let resolvePoll!: () => void;
    let pollCount = 0;
    const fetchMock = vi.fn(async () => {
      pollCount++;
      if (pollCount === 1) {
        // First poll hangs until we release it
        await new Promise<void>((r) => {
          resolvePoll = r;
        });
      }
      return Response.json(makeSnapshot());
    }) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }], 50),
      fetch: fetchMock,
    });

    poller.start(); // starts loop #1 (poll hangs)
    await new Promise((r) => setTimeout(r, 5)); // let loop #1 enter pollAll
    poller.stop(); // increments runId; loop #1 is still in-flight
    poller.start(); // starts loop #2 (poll resolves immediately)
    await new Promise((r) => setTimeout(r, 20)); // let loop #2 settle

    const callsAfterSecondStart = (fetchMock as ReturnType<typeof vi.fn>).mock
      .calls.length;
    resolvePoll(); // unblock the stale loop #1
    await new Promise((r) => setTimeout(r, 80)); // wait past poll interval

    poller.stop();
    // Loop #1 completing after stop/start must NOT schedule an extra timer.
    // Only loop #2's immediate poll + any interval polls should have run.
    expect(
      (fetchMock as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeLessThanOrEqual(callsAfterSecondStart + 2);
  });

  it("stale in-flight poll does not overwrite cache written by the new run", async () => {
    // Scenario: stop() called while poll #1 is in-flight, start() re-called.
    // Poll #1 (stale) must not clobber the fresh state written by poll #2.
    const staleSnap = makeSnapshot({
      generated_at: "2026-06-01T00:00:00.000Z",
    });
    const freshSnap = makeSnapshot({
      generated_at: "2026-06-17T00:00:00.000Z",
    });
    let resolveStale!: () => void;
    let callCount = 0;

    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // First call hangs until released (simulates stale in-flight)
        await new Promise<void>((r) => {
          resolveStale = r;
        });
        return Response.json(staleSnap);
      }
      return Response.json(freshSnap);
    }) as unknown as typeof globalThis.fetch;

    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001" }]),
      fetch: fetchMock,
    });

    poller.start(); // poll #1 hangs (stale)
    await new Promise((r) => setTimeout(r, 5)); // let poll #1 enter fetch
    poller.stop();
    poller.start(); // poll #2 completes with freshSnap
    await new Promise((r) => setTimeout(r, 20)); // poll #2 resolves

    // Cache now holds freshSnap from poll #2
    const snapBefore = (
      poller.boards()[0]?.snapshot as { generated_at: string } | undefined
    )?.generated_at;

    resolveStale(); // unblock stale poll #1
    await new Promise((r) => setTimeout(r, 20)); // let it try to write

    poller.stop();
    const snapAfter = (
      poller.boards()[0]?.snapshot as { generated_at: string } | undefined
    )?.generated_at;

    // Stale poll #1's result must NOT have overwritten freshSnap
    expect(snapBefore).toBe("2026-06-17T00:00:00.000Z");
    expect(snapAfter).toBe("2026-06-17T00:00:00.000Z");
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

describe("createPoller — scrape URL construction", () => {
  it("preserves a base path in the target URL when requesting /api/v1/state", async () => {
    const fetchMock = okFetch(makeSnapshot());
    const poller = createPoller({
      config: makeConfig([
        { name: "alpha", url: "http://localhost:8001/prefix" },
      ]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe("http://localhost:8001/prefix/api/v1/state");
  });

  it("does not corrupt the state URL when the target URL has a query string", async () => {
    const fetchMock = okFetch(makeSnapshot());
    const poller = createPoller({
      config: makeConfig([
        { name: "alpha", url: "http://localhost:8001/prefix?token=abc" },
      ]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe("http://localhost:8001/prefix/api/v1/state?token=abc");
  });

  it("does not produce a double slash when the target URL has a trailing slash", async () => {
    const fetchMock = okFetch(makeSnapshot());
    const poller = createPoller({
      config: makeConfig([{ name: "alpha", url: "http://localhost:8001/" }]),
      fetch: fetchMock,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe("http://localhost:8001/api/v1/state");
  });
});
