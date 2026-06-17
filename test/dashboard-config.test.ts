import { describe, expect, it } from "vitest";
import { buildDashboardConfig } from "../src/dashboard/config.js";

const validRaw = {
  server: { host: "127.0.0.1", port: 8080 },
  poll_interval_ms: 5000,
  targets: [
    { name: "baton", url: "http://127.0.0.1:8787" },
    { name: "kikuchu-app", url: "http://127.0.0.1:8788" },
  ],
};

describe("buildDashboardConfig — valid config", () => {
  it("parses a complete config", () => {
    const cfg = buildDashboardConfig(validRaw);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.port).toBe(8080);
    expect(cfg.pollIntervalMs).toBe(5000);
    expect(cfg.targets).toHaveLength(2);
    expect(cfg.targets[0]).toEqual({
      name: "baton",
      url: "http://127.0.0.1:8787",
    });
    expect(cfg.targets[1]).toEqual({
      name: "kikuchu-app",
      url: "http://127.0.0.1:8788",
    });
  });

  it("accepts https URLs", () => {
    const cfg = buildDashboardConfig({
      targets: [{ name: "secure", url: "https://example.com" }],
    });
    expect(cfg.targets[0]?.url).toBe("https://example.com");
  });
});

describe("buildDashboardConfig — defaults", () => {
  it("defaults host to 127.0.0.1", () => {
    const cfg = buildDashboardConfig({
      server: { port: 9090 },
      targets: [{ name: "a", url: "http://localhost:8787" }],
    });
    expect(cfg.server.host).toBe("127.0.0.1");
  });

  it("defaults server.port to 8080", () => {
    const cfg = buildDashboardConfig({
      targets: [{ name: "a", url: "http://localhost:8787" }],
    });
    expect(cfg.server.port).toBe(8080);
  });

  it("defaults poll_interval_ms to 5000", () => {
    const cfg = buildDashboardConfig({
      targets: [{ name: "a", url: "http://localhost:8787" }],
    });
    expect(cfg.pollIntervalMs).toBe(5000);
  });

  it("omitting server section still applies defaults", () => {
    const cfg = buildDashboardConfig({
      targets: [{ name: "a", url: "http://localhost" }],
    });
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.port).toBe(8080);
  });
});

describe("buildDashboardConfig — invalid values", () => {
  it("rejects non-map top-level value", () => {
    expect(() => buildDashboardConfig("not a map")).toThrowError(
      /must be a YAML mapping/,
    );
  });

  it("rejects empty targets array", () => {
    expect(() => buildDashboardConfig({ targets: [] })).toThrowError(
      /non-empty/,
    );
  });

  it("rejects missing targets", () => {
    expect(() => buildDashboardConfig({})).toThrowError(/non-empty/);
  });

  it("rejects duplicate target names", () => {
    expect(() =>
      buildDashboardConfig({
        targets: [
          { name: "dup", url: "http://127.0.0.1:8787" },
          { name: "dup", url: "http://127.0.0.1:8788" },
        ],
      }),
    ).toThrowError(/duplicate name/);
  });

  it("rejects invalid URL", () => {
    expect(() =>
      buildDashboardConfig({
        targets: [{ name: "bad", url: "not-a-url" }],
      }),
    ).toThrowError(/valid http\/https URL/);
  });

  it("rejects non-http/https URL", () => {
    expect(() =>
      buildDashboardConfig({
        targets: [{ name: "ftp", url: "ftp://example.com" }],
      }),
    ).toThrowError(/valid http\/https URL/);
  });

  it("rejects missing target name", () => {
    expect(() =>
      buildDashboardConfig({
        targets: [{ url: "http://localhost:8787" }],
      }),
    ).toThrowError(/name must be a non-empty string/);
  });

  it("rejects missing target URL", () => {
    expect(() =>
      buildDashboardConfig({
        targets: [{ name: "a" }],
      }),
    ).toThrowError(/url must be a valid http\/https URL/);
  });

  it("rejects out-of-range port (0)", () => {
    expect(() =>
      buildDashboardConfig({
        server: { port: 0 },
        targets: [{ name: "a", url: "http://localhost" }],
      }),
    ).toThrowError(/\[1, 65535\]/);
  });

  it("rejects out-of-range port (65536)", () => {
    expect(() =>
      buildDashboardConfig({
        server: { port: 65536 },
        targets: [{ name: "a", url: "http://localhost" }],
      }),
    ).toThrowError(/\[1, 65535\]/);
  });

  it("rejects non-integer port", () => {
    expect(() =>
      buildDashboardConfig({
        server: { port: "abc" },
        targets: [{ name: "a", url: "http://localhost" }],
      }),
    ).toThrowError(/\[1, 65535\]/);
  });

  it("rejects non-positive poll_interval_ms", () => {
    expect(() =>
      buildDashboardConfig({
        poll_interval_ms: 0,
        targets: [{ name: "a", url: "http://localhost" }],
      }),
    ).toThrowError(/poll_interval_ms/);
  });

  it("rejects string poll_interval_ms", () => {
    expect(() =>
      buildDashboardConfig({
        poll_interval_ms: "fast",
        targets: [{ name: "a", url: "http://localhost" }],
      }),
    ).toThrowError(/poll_interval_ms/);
  });

  it("rejects non-map target entry", () => {
    expect(() =>
      buildDashboardConfig({
        targets: ["not-a-map"],
      }),
    ).toThrowError(/must be a mapping/);
  });
});
