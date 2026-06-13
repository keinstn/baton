import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, spawn: spawnMock };
});

describe("stopSessionProcess Windows shutdown", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("force-settles an in-flight turn when taskkill succeeds but close never arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const taskkill = new EventEmitter();
    spawnMock.mockImplementation(() => {
      setTimeout(() => taskkill.emit("close", 0), 0);
      return taskkill as never;
    });

    const { stopSessionProcess } = await import("../src/agent/process.js");

    let releaseClose = () => {};
    const procClosed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const procForceClose = vi.fn(() => releaseClose());
    const session = {
      workspace: "/tmp/ws",
      agentSessionId: null,
      proc: {
        pid: 123,
        exitCode: null,
        kill: vi.fn(),
      } as unknown as ChildProcess,
      procClosed,
      procForceClose,
      turnNumber: 0,
    };

    const stopping = stopSessionProcess(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(procForceClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await stopping;

    expect(procForceClose).toHaveBeenCalledTimes(1);
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
    expect(session.procForceClose).toBeNull();
  });
});
