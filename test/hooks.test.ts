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

  it("forces timeout completion on Windows even if close never arrives", async () => {
    const proc = new FakeChildProcess(321);
    const taskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      setTimeout(() => taskkill.emit("close", 1), 0);
      return taskkill;
    });

    const { runHookScript } = await import("../src/workspace/hooks.js");
    const start = Date.now();
    const result = await runHookScript("sleep 30", {
      cwd: "/tmp",
      timeoutMs: 10,
      timeoutGraceMs: 20,
      platform: "win32",
    });

    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      code: null,
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(proc.unref).toHaveBeenCalled();
  });
});
