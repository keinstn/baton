import type { OrchestratorSnapshot } from "../orchestrator/orchestrator.js";
import type { BoardState, DashboardConfig, DashboardTarget } from "./config.js";

const SCRAPE_TIMEOUT_MS = 10_000;

export interface AggregatedTotals {
  running: number;
  retrying: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface PollerDeps {
  config: DashboardConfig;
  /** Injected for testing; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface Poller {
  /** Current per-board cache (snapshot of the internal map). */
  boards(): BoardState[];
  /** Cross-board aggregated totals. */
  totals(): AggregatedTotals;
  start(): void;
  stop(): void;
}

async function scrape(
  target: DashboardTarget,
  fetchFn: typeof globalThis.fetch,
): Promise<BoardState> {
  const url = `${target.url}/api/v1/state`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  let raw: unknown;
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) {
      return {
        name: target.name,
        url: target.url,
        up: false,
        lastScrapedAt: new Date(),
        error: `HTTP ${res.status}`,
      };
    }
    raw = await res.json();
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : err.message
        : String(err);
    return {
      name: target.name,
      url: target.url,
      up: false,
      lastScrapedAt: new Date(),
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!isSnapshot(raw)) {
    return {
      name: target.name,
      url: target.url,
      up: false,
      lastScrapedAt: new Date(),
      error: "invalid JSON response",
    };
  }

  return {
    name: target.name,
    url: target.url,
    up: true,
    lastScrapedAt: new Date(),
    snapshot: raw,
  };
}

function isSnapshot(v: unknown): v is OrchestratorSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.generated_at === "string" &&
    Array.isArray(s.running) &&
    Array.isArray(s.retrying)
  );
}

export function createPoller(deps: PollerDeps): Poller {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const cache = new Map<string, BoardState>(
    deps.config.targets.map((t) => [
      t.name,
      { name: t.name, url: t.url, up: false, lastScrapedAt: null },
    ]),
  );

  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function pollAll(): Promise<void> {
    await Promise.all(
      deps.config.targets.map(async (target) => {
        try {
          const state = await scrape(target, fetchFn);
          cache.set(target.name, state);
        } catch {
          // scrape() is already fully try/caught; this is a safety net
        }
      }),
    );
  }

  return {
    boards(): BoardState[] {
      return Array.from(cache.values());
    },

    totals(): AggregatedTotals {
      let running = 0;
      let retrying = 0;
      let input_tokens = 0;
      let output_tokens = 0;
      let total_tokens = 0;
      let seconds_running = 0;

      for (const state of cache.values()) {
        if (!state.up || !state.snapshot) continue;
        const snap = state.snapshot as OrchestratorSnapshot;
        running += snap.running.length;
        retrying += snap.retrying.length;
        input_tokens += snap.agent_totals.input_tokens;
        output_tokens += snap.agent_totals.output_tokens;
        total_tokens += snap.agent_totals.total_tokens;
        seconds_running += snap.agent_totals.seconds_running;
      }

      return {
        running,
        retrying,
        input_tokens,
        output_tokens,
        total_tokens,
        seconds_running,
      };
    },

    start(): void {
      if (intervalId !== null) return;
      void pollAll();
      intervalId = setInterval(() => {
        void pollAll();
      }, deps.config.pollIntervalMs);
    },

    stop(): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}
