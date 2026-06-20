import { describe, expect, it } from "vitest";
import { parseDashboardArgs } from "../src/dashboard/cli-args.js";

describe("parseDashboardArgs", () => {
  it("defaults to ./baton-dashboard.yaml and no port", () => {
    expect(parseDashboardArgs([])).toEqual({
      configPath: "./baton-dashboard.yaml",
      port: null,
    });
  });

  it("takes a positional config path", () => {
    expect(parseDashboardArgs(["my-config.yaml"])).toEqual({
      configPath: "my-config.yaml",
      port: null,
    });
  });

  it("accepts --port, -p, and --port= forms", () => {
    expect(parseDashboardArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseDashboardArgs(["-p", "9000"]).port).toBe(9000);
    expect(parseDashboardArgs(["--port=7000"]).port).toBe(7000);
  });

  it("combines a config path and a port in any order", () => {
    expect(parseDashboardArgs(["cfg.yaml", "--port", "8080"])).toEqual({
      configPath: "cfg.yaml",
      port: 8080,
    });
    expect(parseDashboardArgs(["--port=8080", "cfg.yaml"])).toEqual({
      configPath: "cfg.yaml",
      port: 8080,
    });
  });

  it("rejects a missing port argument", () => {
    expect(() => parseDashboardArgs(["--port"])).toThrow(/requires an integer/);
  });

  it("rejects out-of-range and non-integer ports", () => {
    expect(() => parseDashboardArgs(["--port", "0"])).toThrow(/invalid --port/);
    expect(() => parseDashboardArgs(["--port", "70000"])).toThrow(
      /invalid --port/,
    );
    expect(() => parseDashboardArgs(["--port", "abc"])).toThrow(
      /invalid --port/,
    );
  });

  it("rejects an unexpected second positional argument", () => {
    expect(() => parseDashboardArgs(["a.yaml", "b.yaml"])).toThrow(
      /unexpected argument/,
    );
  });
});
