import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTreeKiller } from "../src/agent/tree-killer.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Inject the Windows killer rather than spying on process.platform.
const windows = makeTreeKiller("win32");

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid?: number;
  exitCode: number | null = null;
  kill = vi.fn();
  unref = vi.fn();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

describe("runHookScript", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.resetModules();
  });

  it("kills the process tree by PID on a Windows timeout", async () => {
    const proc = new FakeChildProcess(321);
    const taskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      // taskkill confirms the kill, then the wrapper closes.
      setTimeout(() => {
        taskkill.emit("close", 0);
        proc.emit("close", null);
      }, 0);
      return taskkill;
    });

    const { runHookScript } = await import("../src/workspace/hooks.js");
    const result = await runHookScript("sleep 30", {
      cwd: "/tmp",
      timeoutMs: 10,
      treeKiller: windows,
    });

    expect(result).toMatchObject({ ok: false, timedOut: true, code: null });
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", "321"],
      expect.anything(),
    );
    // taskkill succeeded, so the single-process SIGKILL fallback is not used.
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("force-settles a Windows timeout when close never arrives", async () => {
    vi.useFakeTimers();
    const proc = new FakeChildProcess(321);
    const taskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      // taskkill confirms, but the wrapper `close` event never fires.
      setTimeout(() => taskkill.emit("close", 0), 0);
      return taskkill;
    });

    const { runHookScript } = await import("../src/workspace/hooks.js");
    const pending = runHookScript("sleep 30", {
      cwd: "/tmp",
      timeoutMs: 10,
      treeKiller: windows,
    });

    // timeoutMs (10) → tree kill → grace (1000) → forced timeout result.
    await vi.advanceTimersByTimeAsync(1100);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      timedOut: true,
      code: null,
    });
    expect(proc.unref).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
