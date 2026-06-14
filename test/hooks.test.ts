import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

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
      platform: "win32",
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
});
