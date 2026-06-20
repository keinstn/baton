import { describe, expect, it } from "vitest";
import { validateDashboardConfig } from "../src/dashboard/config.js";

const validConfig = {
  server: { host: "127.0.0.1", port: 8800 },
  targets: [
    { name: "implementer", url: "http://127.0.0.1:8787" },
    { name: "reviewer", url: "http://127.0.0.1:8788" },
  ],
};

describe("validateDashboardConfig", () => {
  it("accepts a valid config", () => {
    expect(validateDashboardConfig(validConfig)).toEqual(validConfig);
  });

  it("defaults host and port when server is omitted", () => {
    const result = validateDashboardConfig({
      targets: [{ name: "a", url: "http://localhost:8080" }],
    });
    expect(result.server.host).toBe("127.0.0.1");
    expect(result.server.port).toBe(8888);
  });

  it("rejects a non-object root", () => {
    expect(() => validateDashboardConfig("not an object")).toThrow(
      /config must be an object/,
    );
  });

  it("rejects empty targets array", () => {
    expect(() =>
      validateDashboardConfig({ ...validConfig, targets: [] }),
    ).toThrow(/non-empty array/);
  });

  it("rejects missing targets", () => {
    expect(() =>
      validateDashboardConfig({ server: { host: "127.0.0.1", port: 8800 } }),
    ).toThrow(/non-empty array/);
  });

  it("rejects duplicate target names", () => {
    expect(() =>
      validateDashboardConfig({
        ...validConfig,
        targets: [
          { name: "a", url: "http://localhost:8787" },
          { name: "a", url: "http://localhost:8788" },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects non-http/https URLs", () => {
    expect(() =>
      validateDashboardConfig({
        ...validConfig,
        targets: [{ name: "a", url: "ftp://example.com" }],
      }),
    ).toThrow(/http or https/);
  });

  it("rejects invalid URLs", () => {
    expect(() =>
      validateDashboardConfig({
        ...validConfig,
        targets: [{ name: "a", url: "not-a-url" }],
      }),
    ).toThrow(/not a valid URL/);
  });

  it("rejects an invalid port number", () => {
    expect(() =>
      validateDashboardConfig({
        ...validConfig,
        server: { host: "127.0.0.1", port: 99999 },
      }),
    ).toThrow(/integer between 1 and 65535/);
  });

  it("rejects an empty target name", () => {
    expect(() =>
      validateDashboardConfig({
        ...validConfig,
        targets: [{ name: "", url: "http://localhost:8787" }],
      }),
    ).toThrow(/non-empty string/);
  });
});
