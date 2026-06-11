import { describe, expect, it } from "vitest";
import { isRecord, norm, now } from "../src/util.js";

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
