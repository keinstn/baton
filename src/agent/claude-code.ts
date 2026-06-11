import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ClaudeCodeConfig } from "../config/schema.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import type {
  AgentEvent,
  AgentEventCallback,
  AgentRunner,
  AgentSession,
  TurnResult,
} from "./runner.js";

/** Quote a string for safe interpolation into a bash -lc command line. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Claude Code adapter, CLI subprocess mode (SPEC §10.1).
 *
 * One turn per `claude -p` invocation with stream-json output. The prompt is
 * delivered on stdin to avoid argv length limits. Continuation turns resume the
 * prior session via `--resume <agent_session_id>` (SPEC §7.1, §10.1).
 */
export class ClaudeCodeRunner implements AgentRunner {
  constructor(
    private readonly cfg: ClaudeCodeConfig,
    private readonly logger: Logger,
  ) {}

  /** Build the full shell command line. `cfg.command` is itself a shell string (SPEC §5.3.6).
   *  A non-null `resumeId` adds `--resume` so continuation turns reuse the session. */
  buildCommand(resumeId?: string | null): string {
    const parts: string[] = [
      this.cfg.command,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      shellQuote(this.cfg.permissionMode),
    ];
    if (resumeId) {
      parts.push("--resume", shellQuote(resumeId));
    }
    if (this.cfg.model) {
      parts.push("--model", shellQuote(this.cfg.model));
    }
    if (this.cfg.allowedTools.length > 0) {
      parts.push("--allowedTools", shellQuote(this.cfg.allowedTools.join(",")));
    }
    if (this.cfg.disallowedTools.length > 0) {
      parts.push(
        "--disallowedTools",
        shellQuote(this.cfg.disallowedTools.join(",")),
      );
    }
    if (this.cfg.appendSystemPrompt) {
      parts.push(
        "--append-system-prompt",
        shellQuote(this.cfg.appendSystemPrompt),
      );
    }
    parts.push(...this.cfg.extraArgs);
    return parts.join(" ");
  }

  async startSession(workspace: string): Promise<AgentSession> {
    // SPEC §9.5 Invariant 1: validate cwd before launching the agent.
    let isDir = false;
    try {
      isDir = (await stat(workspace)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new BatonError(
        "invalid_workspace_cwd",
        `not a directory: ${workspace}`,
      );
    }
    return { workspace, agentSessionId: null, proc: null, turnNumber: 0 };
  }

  runTurn(
    session: AgentSession,
    prompt: string,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult> {
    // Continuation turns (those after the first) resume the established session
    // so the agent keeps its context (SPEC §7.1, §10.1).
    session.turnNumber += 1;
    const resumeId = session.turnNumber > 1 ? session.agentSessionId : null;
    return new Promise((resolvePromise) => {
      // detached: own process group, so timeout/stop kills the whole agent
      // process tree (not just the bash -lc wrapper).
      const proc = spawn("bash", ["-lc", this.buildCommand(resumeId)], {
        cwd: session.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      session.proc = proc;

      proc.stdin.on("error", () => {
        // Process may exit before consuming stdin; close handler reports it.
      });
      proc.stdin.write(prompt);
      proc.stdin.end();

      let stderrTail = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });

      let result: TurnResult | null = null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc);
      }, this.cfg.turnTimeoutMs);

      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        const turnResult = this.handleLine(session, line, onEvent);
        if (turnResult) result = turnResult;
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, error: `startup_failed: ${String(err)}` });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        session.proc = null;
        if (timedOut) {
          onEvent({
            event: "turn_cancelled",
            timestamp: now(),
            message: "turn_timeout",
          });
          resolvePromise({ ok: false, error: "turn_timeout" });
        } else if (result) {
          resolvePromise(result);
        } else {
          const error = `process_exit code=${code} stderr=${stderrTail.slice(-500)}`;
          onEvent({ event: "turn_failed", timestamp: now(), message: error });
          resolvePromise(code === 0 ? { ok: true } : { ok: false, error });
        }
      });
    });
  }

  /** Parse one stream-json line into normalized events; return the turn result when seen. */
  private handleLine(
    session: AgentSession,
    line: string,
    onEvent: AgentEventCallback,
  ): TurnResult | null {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      onEvent({
        event: "malformed",
        timestamp: now(),
        message: trimmed.slice(0, 200),
      });
      return null;
    }
    switch (msg["type"]) {
      case "system": {
        if (
          msg["subtype"] === "init" &&
          typeof msg["session_id"] === "string"
        ) {
          session.agentSessionId = msg["session_id"];
          // session_started is emitted once, on the first turn, carrying the
          // composite id `<agent_session_id>-1`; continuation turns increment
          // turn_number instead of re-emitting (SPEC §10.1, §17.5).
          if (session.turnNumber <= 1) {
            onEvent({
              event: "session_started",
              timestamp: now(),
              payload: {
                session_id: `${msg["session_id"]}-${session.turnNumber}`,
              },
            });
          }
        } else {
          onEvent({ event: "other_message", timestamp: now() });
        }
        return null;
      }
      case "assistant": {
        for (const event of summarizeAssistant(msg)) onEvent(event);
        return null;
      }
      case "result": {
        const ok = msg["is_error"] !== true;
        const usage = readUsage(msg["usage"]);
        onEvent({
          event: ok ? "turn_completed" : "turn_failed",
          timestamp: now(),
          message:
            typeof msg["result"] === "string"
              ? msg["result"].slice(0, 500)
              : undefined,
          ...(usage ? { usage } : {}),
        });
        return ok
          ? { ok: true }
          : {
              ok: false,
              error:
                typeof msg["result"] === "string"
                  ? msg["result"].slice(0, 500)
                  : `result subtype=${String(msg["subtype"])}`,
            };
      }
      default: {
        onEvent({ event: "other_message", timestamp: now() });
        return null;
      }
    }
  }

  async stopSession(session: AgentSession): Promise<void> {
    if (
      session.proc &&
      session.proc.exitCode === null &&
      !session.proc.killed
    ) {
      killProcessTree(session.proc);
    }
    session.proc = null;
  }
}

/** Kill the agent's whole process group (requires spawn with detached: true). */
function killProcessTree(proc: ChildProcess): void {
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to single-process kill.
    }
  }
  proc.kill("SIGKILL");
}

function readUsage(
  v: unknown,
): { inputTokens: number; outputTokens: number } | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
  const output =
    typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
  return { inputTokens: input, outputTokens: output };
}

function summarizeAssistant(msg: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = [];
  const message = msg["message"] as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content as Record<string, unknown>[]) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      events.push({
        event: "notification",
        timestamp: now(),
        message: block["text"].slice(0, 200),
      });
    } else if (
      block["type"] === "tool_use" &&
      typeof block["name"] === "string"
    ) {
      events.push({
        event: "tool_use",
        timestamp: now(),
        message: block["name"],
      });
    }
  }
  if (events.length === 0) {
    events.push({ event: "other_message", timestamp: now() });
  }
  return events;
}
