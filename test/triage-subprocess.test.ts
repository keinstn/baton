import { describe, expect, it } from "vitest";
import { runOnce } from "../scripts/lib/subprocess.js";

describe("runOnce", () => {
  it("resolves with stdout when process exits 0", async () => {
    const output = await runOnce("echo hello");
    expect(output.trim()).toBe("hello");
  });

  it("collects multi-line stdout", async () => {
    const output = await runOnce("printf 'line1\\nline2\\nline3'");
    expect(output).toBe("line1\nline2\nline3");
  });

  it("writes stdin to the process and collects stdout", async () => {
    const output = await runOnce("cat", "hello stdin");
    expect(output).toBe("hello stdin");
  });

  it("rejects with exit code when process exits non-zero", async () => {
    await expect(runOnce("exit 42")).rejects.toThrow("42");
  });

  it("rejects with timeout error when process exceeds timeoutMs", async () => {
    // Use a very short timeout so the test runs quickly
    await expect(
      runOnce("sleep 10", undefined, { timeoutMs: 100 }),
    ).rejects.toThrow("timed out");
  });
});
