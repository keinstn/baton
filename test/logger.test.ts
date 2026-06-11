import { describe, expect, it } from "vitest";
import { Logger } from "../src/observability/logger.js";

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("Logger", () => {
  it("emits one JSON object per line with level, msg, ts and fields", () => {
    const { lines, sink } = capture();
    new Logger({ service: "baton" }, sink).info("started", { port: 8787 });

    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0] as string);
    expect(obj.level).toBe("info");
    expect(obj.msg).toBe("started");
    expect(obj.service).toBe("baton");
    expect(obj.port).toBe(8787);
    expect(typeof obj.ts).toBe("string");
  });

  it("supports all four levels", () => {
    const { lines, sink } = capture();
    const log = new Logger({}, sink);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l).level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("merges parent context into children, with child fields winning", () => {
    const { lines, sink } = capture();
    const parent = new Logger({ service: "baton", scope: "root" }, sink);
    parent.child({ scope: "worker", issue_id: "I_1" }).info("hi");

    const obj = JSON.parse(lines[0] as string);
    expect(obj.service).toBe("baton");
    expect(obj.scope).toBe("worker");
    expect(obj.issue_id).toBe("I_1");
  });

  it("per-call fields override context fields", () => {
    const { lines, sink } = capture();
    new Logger({ scope: "a" }, sink).info("m", { scope: "b" });
    expect(JSON.parse(lines[0] as string).scope).toBe("b");
  });

  it("never throws when the sink fails (SPEC §13.2)", () => {
    const log = new Logger({}, () => {
      throw new Error("sink down");
    });
    expect(() => log.error("boom")).not.toThrow();
  });
});
