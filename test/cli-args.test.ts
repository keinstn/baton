import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("parseArgs", () => {
  it("defaults to ./WORKFLOW.md and no port", () => {
    expect(parseArgs([])).toEqual({
      workflowPath: "./WORKFLOW.md",
      port: null,
    });
  });

  it("takes a positional workflow path", () => {
    expect(parseArgs(["flows/WORKFLOW.md"])).toEqual({
      workflowPath: "flows/WORKFLOW.md",
      port: null,
    });
  });

  it("accepts --port, -p, and --port= forms", () => {
    expect(parseArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseArgs(["-p", "9000"]).port).toBe(9000);
    expect(parseArgs(["--port=7000"]).port).toBe(7000);
  });

  it("combines a workflow path and a port in any order", () => {
    expect(parseArgs(["w.md", "--port", "8080"])).toEqual({
      workflowPath: "w.md",
      port: 8080,
    });
    expect(parseArgs(["--port=8080", "w.md"])).toEqual({
      workflowPath: "w.md",
      port: 8080,
    });
  });

  it("rejects a missing port argument", () => {
    expect(() => parseArgs(["--port"])).toThrow(/requires an integer/);
  });

  it("rejects out-of-range and non-integer ports", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow(/invalid --port/);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/invalid --port/);
    expect(() => parseArgs(["--port", "abc"])).toThrow(/invalid --port/);
  });

  it("rejects an unexpected second positional argument", () => {
    expect(() => parseArgs(["a.md", "b.md"])).toThrow(/unexpected argument/);
  });
});
