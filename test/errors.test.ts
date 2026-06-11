import { describe, expect, it } from "vitest";
import { BatonError, isBatonError } from "../src/errors.js";

describe("BatonError", () => {
  it("carries a stable code and defaults the message to the code", () => {
    const err = new BatonError("config_invalid");
    expect(err.code).toBe("config_invalid");
    expect(err.message).toBe("config_invalid");
    expect(err.name).toBe("BatonError");
    expect(err).toBeInstanceOf(Error);
  });

  it("keeps an explicit message", () => {
    const err = new BatonError("hook_failed", "exit 1");
    expect(err.code).toBe("hook_failed");
    expect(err.message).toBe("exit 1");
  });
});

describe("isBatonError", () => {
  it("narrows BatonError instances", () => {
    expect(isBatonError(new BatonError("turn_failed"))).toBe(true);
    expect(isBatonError(new Error("nope"))).toBe(false);
    expect(isBatonError("string")).toBe(false);
    expect(isBatonError(null)).toBe(false);
  });

  it("optionally matches a specific code", () => {
    const err = new BatonError("turn_timeout");
    expect(isBatonError(err, "turn_timeout")).toBe(true);
    expect(isBatonError(err, "turn_failed")).toBe(false);
  });
});
