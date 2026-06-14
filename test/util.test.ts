import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeCommandForBash,
  stopSessionProcess,
} from "../src/agent/process.js";
import { isRecord, norm, now, toBashPath } from "../src/util.js";

describe("norm", () => {
  it("trims and lowercases", () => {
    expect(norm("  In Progress ")).toBe("in progress");
    expect(norm("DONE")).toBe("done");
    expect(norm("")).toBe("");
  });
});

describe("now", () => {
  it("returns a parseable ISO-8601 timestamp", () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });
});

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("toBashPath", () => {
  it("converts Windows absolute paths to Git Bash form", () => {
    expect(toBashPath("C:\\Users\\baton\\ws", "win32")).toBe(
      "/c/Users/baton/ws",
    );
  });

  it("leaves non-Windows paths unchanged", () => {
    expect(toBashPath("/tmp/ws", "linux")).toBe("/tmp/ws");
  });
});

describe("normalizeCommandForBash", () => {
  it("normalizes a bare Windows executable path for Git Bash", () => {
    expect(normalizeCommandForBash("C:\\tools\\claude.exe", "win32")).toBe(
      "'/c/tools/claude.exe'",
    );
  });

  it("normalizes a quoted Windows executable path with spaces", () => {
    expect(
      normalizeCommandForBash(
        '"C:\\Program Files\\GitHub Copilot\\copilot.exe"',
        "win32",
      ),
    ).toBe("'/c/Program Files/GitHub Copilot/copilot.exe'");
  });

  it("does not rewrite complex shell strings", () => {
    expect(
      normalizeCommandForBash("C:\\tools\\claude.exe --verbose", "win32"),
    ).toBe("C:\\tools\\claude.exe --verbose");
  });
});

describe("stopSessionProcess", () => {
  it("waits for a running process to finish closing before clearing the handle", async () => {
    const proc = {
      pid: undefined,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    let releaseClose = () => {};
    const procClosed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const session = {
      workspace: "/tmp/ws",
      agentSessionId: null,
      proc,
      procClosed,
      procForceClose: null,
      turnNumber: 0,
    };
    let settled = false;
    const stopping = stopSessionProcess(session).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(session.proc).toBe(proc);
    expect(settled).toBe(false);
    releaseClose();
    await stopping;
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
  });

  it("clears the process handle once the child has already exited", async () => {
    const proc = {
      pid: undefined,
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const session = {
      workspace: "/tmp/ws",
      agentSessionId: null,
      proc,
      procClosed: Promise.resolve(),
      procForceClose: null,
      turnNumber: 0,
    };
    await stopSessionProcess(session);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
  });

  it("force-settles via procForceClose when close never arrives", async () => {
    vi.useFakeTimers();
    const proc = {
      pid: undefined,
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    let releaseClose = () => {};
    const procClosed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    // Mirrors runSubprocess: procForceClose force-settles the turn and resolves
    // procClosed when the OS never delivers the child `close`.
    const procForceClose = vi.fn(() => releaseClose());
    const session = {
      workspace: "/tmp/ws",
      agentSessionId: null,
      proc,
      procClosed,
      procForceClose,
      turnNumber: 0,
    };
    let settled = false;
    const stopping = stopSessionProcess(session).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(session.proc).toBe(proc);
    expect(procForceClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(procForceClose).toHaveBeenCalledTimes(1);
    expect(session.proc).toBeNull();
    expect(session.procClosed).toBeNull();
    vi.useRealTimers();
  });
});
