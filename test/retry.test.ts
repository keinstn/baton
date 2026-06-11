import { describe, expect, it } from "vitest";
import {
  CONTINUATION_DELAY_MS,
  failureBackoffMs,
} from "../src/orchestrator/retry.js";

describe("retry backoff (SPEC §8.4)", () => {
  it("uses a 1 second continuation delay", () => {
    expect(CONTINUATION_DELAY_MS).toBe(1000);
  });

  it("doubles from 10s per attempt", () => {
    expect(failureBackoffMs(1, 300000)).toBe(10000);
    expect(failureBackoffMs(2, 300000)).toBe(20000);
    expect(failureBackoffMs(3, 300000)).toBe(40000);
    expect(failureBackoffMs(5, 300000)).toBe(160000);
  });

  it("caps at agent.max_retry_backoff_ms", () => {
    expect(failureBackoffMs(6, 300000)).toBe(300000);
    expect(failureBackoffMs(50, 300000)).toBe(300000);
    expect(failureBackoffMs(3, 15000)).toBe(15000);
  });
});
