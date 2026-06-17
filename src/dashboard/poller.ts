import type { OrchestratorSnapshot } from "../orchestrator/orchestrator.js";
import {
  type BoardState,
  buildBoardApiUrl,
  type DashboardConfig,
  type DashboardTarget,
} from "./config.js";
import { normalizeRetryingEntry, normalizeRunningEntry } from "./normalize.js";

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
  const url = buildBoardApiUrl(target.url, "/api/v1/state");
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
  if (
    typeof s.generated_at !== "string" ||
    !Array.isArray(s.running) ||
    !Array.isArray(s.retrying)
  )
    return false;
  const t = s.agent_totals;
  if (typeof t !== "object" || t === null) return false;
  const totals = t as Record<string, unknown>;
  return (
    typeof totals.input_tokens === "number" &&
    typeof totals.output_tokens === "number" &&
    typeof totals.total_tokens === "number" &&
    typeof totals.seconds_running === "number"
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

  let started = false;
  /**
   * Monotonically increasing generation for the current poller run.
   *
   * Passed into `loop()` / `pollAll()` so that stale async work finishing after
   * a `stop()` / `start()` boundary can detect it is outdated and skip both
   * rescheduling and cache writes.
   */
  let runId = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function pollAll(myRunId: number): Promise<void> {
    await Promise.all(
      deps.config.targets.map(async (target) => {
        try {
          const state = await scrape(target, fetchFn);
          if (started && myRunId === runId) {
            cache.set(target.name, state);
          }
        } catch {
          // scrape() is already fully try/caught; this is a safety net
        }
      }),
    );
  }

  async function loop(myRunId: number): Promise<void> {
    await pollAll(myRunId);
    if (!started || myRunId !== runId) return;
    timeoutId = setTimeout(
      () => void loop(myRunId),
      deps.config.pollIntervalMs,
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
        running += (snap.running as unknown[]).filter(
          (e) => normalizeRunningEntry(e) !== null,
        ).length;
        retrying += (snap.retrying as unknown[]).filter(
          (e) => normalizeRetryingEntry(e) !== null,
        ).length;
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
      if (started) return;
      started = true;
      runId += 1;
      void loop(runId);
    },

    stop(): void {
      started = false;
      runId += 1;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
