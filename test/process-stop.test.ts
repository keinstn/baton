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

function makeSession(): AgentSession {
  return {
    workspace: "/tmp/ws",
    agentSessionId: null,
    proc: null,
    procClosed: null,
    turnNumber: 0,
  };
}

describe("stopSessionProcess Windows shutdown", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("kills the running tree with taskkill and clears the session once it closes", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const proc = new FakeChildProcess(123);
    const taskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      setTimeout(() => {
        taskkill.emit("close", 0);
        proc.exitCode = 0;
        proc.emit("close", 0);
      }, 0);
      return taskkill as never;
    });

    const { runSubprocess, stopSessionProcess } = await import(
      "../src/agent/process.js"
    );

    const session = makeSession();
    void runSubprocess(session, {
      command: "sleep 30",
      timeoutMs: 60_000,
      onEvent: () => {},
      onLine: () => null,
    });

    await stopSessionProcess(session);

    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", "123"],
      expect.anything(),
    );
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
  });

  it("force-settles a timed-out turn on Windows when close never arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const proc = new FakeChildProcess(123);
    const taskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      // taskkill confirms, but the wrapper `close` event never fires — the
      // grace timer must still settle the turn so the worker loop is unblocked.
      setTimeout(() => taskkill.emit("close", 0), 0);
      return taskkill as never;
    });

    const { runSubprocess } = await import("../src/agent/process.js");

    const session = makeSession();
    const turn = runSubprocess(session, {
      command: "sleep 30",
      timeoutMs: 100,
      onEvent: () => {},
      onLine: () => null,
    });

    // timeoutMs (100) elapses → tree kill → grace (1000) → forced turn_timeout.
    await vi.advanceTimersByTimeAsync(1100);
    await expect(turn).resolves.toEqual({ ok: false, error: "turn_timeout" });
    // session.proc is kept so stopSession() can still await the real close.
    expect(session.proc).toBe(proc);
  });

  it("bounds the wait when taskkill runs but the child close never arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const proc = new FakeChildProcess(123);
    const taskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      // taskkill confirms, but the wrapper `close` event never fires.
      setTimeout(() => taskkill.emit("close", 0), 0);
      return taskkill as never;
    });

    const { runSubprocess, stopSessionProcess } = await import(
      "../src/agent/process.js"
    );

    const session = makeSession();
    void runSubprocess(session, {
      command: "sleep 30",
      timeoutMs: 60_000,
      onEvent: () => {},
      onLine: () => null,
    });

    const stopping = stopSessionProcess(session);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(stopping).resolves.toBeUndefined();
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
  });
});
