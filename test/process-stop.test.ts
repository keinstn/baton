import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/agent/runner.js";

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

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid?: number;
  exitCode: number | null = null;
  kill = vi.fn();
  unref = vi.fn();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

describe("stopSessionProcess Windows shutdown", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("force-settles a timed-out turn when stopSession runs after taskkill but close never arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const proc = new FakeChildProcess(123);
    const taskkillForTimeout = new EventEmitter();
    const taskkillForStop = new EventEmitter();
    spawnMock
      .mockReturnValueOnce(proc)
      .mockImplementationOnce(() => {
        setTimeout(() => taskkillForTimeout.emit("close", 0), 0);
        return taskkillForTimeout as never;
      })
      .mockImplementationOnce(() => {
        setTimeout(() => taskkillForStop.emit("close", 0), 0);
        return taskkillForStop as never;
      });

    const { runSubprocess, stopSessionProcess } = await import(
      "../src/agent/process.js"
    );

    const session: AgentSession = {
      workspace: "/tmp/ws",
      agentSessionId: null,
      proc: null,
      procClosed: null,
      procForceClose: null,
      turnNumber: 0,
    };

    const turn = runSubprocess(session, {
      command: "sleep 30",
      timeoutMs: 10,
      onEvent: () => {},
      onLine: () => null,
    });

    await vi.advanceTimersByTimeAsync(1010);
    await expect(turn).resolves.toEqual({ ok: false, error: "turn_timeout" });
    expect(session.proc).toBe(proc);
    expect(session.procClosed).not.toBeNull();
    expect(session.procForceClose).not.toBeNull();

    const stopping = stopSessionProcess(session);
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;

    expect(proc.unref).toHaveBeenCalled();
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
    expect(session.procForceClose).toBeNull();
  });
});
