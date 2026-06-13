import { describe, expect, it } from "vitest";
import { normalizeCommandForBash } from "../src/agent/process.js";
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
