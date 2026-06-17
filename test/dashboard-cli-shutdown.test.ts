import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeShutdown } from "../src/dashboard/shutdown.js";
import { Logger } from "../src/observability/logger.js";

const logger = new Logger({}, () => {});

describe("makeShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the poller, closes the server, and exits on first signal", async () => {
    const stopPoller = vi.fn();
    const closeServer = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const shutdown = makeShutdown({
      stopPoller,
      closeServer,
      exit,
      logger,
      timeoutMs: 100,
    });

    shutdown("SIGINT");
    await vi.runAllTimersAsync();

    expect(stopPoller).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — repeated signals only run shutdown once", async () => {
    const stopPoller = vi.fn();
    const closeServer = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const shutdown = makeShutdown({
      stopPoller,
      closeServer,
      exit,
      logger,
      timeoutMs: 100,
    });

    shutdown("SIGINT");
    shutdown("SIGTERM");
    shutdown("SIGINT");
    await vi.runAllTimersAsync();

    expect(stopPoller).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("exits after timeout when server.close() never resolves", async () => {
    const stopPoller = vi.fn();
    const closeServer = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const shutdown = makeShutdown({
      stopPoller,
      closeServer,
      exit,
      logger,
      timeoutMs: 500,
    });

    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);

    expect(exit).toHaveBeenCalledWith(0);
  });
});
