import type { ClaudeCodeConfig } from "../config/schema.js";
import {
  DISPLAY_TEXT_MAX_BYTES,
  ERROR_MESSAGE_MAX_BYTES,
} from "../constants.js";
import type { Logger } from "../observability/logger.js";
import { makePlatform, type Platform } from "../platform/platform.js";
import { now, shellQuote } from "../util.js";
import {
  createSession,
  parseJsonLine,
  runSubprocess,
  stopSessionProcess,
} from "./process.js";
import type {
  AgentEvent,
  AgentEventCallback,
  AgentRunner,
  AgentSession,
  TurnResult,
} from "./runner.js";

// Re-exported for adapter authors and existing importers (e.g. copilot.ts, tests).
export { shellQuote };

/**
 * Claude Code adapter, CLI subprocess mode (SPEC §10.1).
 *
 * One turn per `claude -p` invocation with stream-json output. The prompt is
 * delivered on stdin to avoid argv length limits. Continuation turns resume the
 * prior session via `--resume <agent_session_id>` (SPEC §7.1, §10.1).
 */
export class ClaudeCodeRunner implements AgentRunner {
  constructor(
    private cfg: ClaudeCodeConfig,
    private readonly logger?: Logger,
    private readonly platform: Platform = makePlatform(),
  ) {}

  /** Apply a new config; takes effect on the next turn dispatch (SPEC §6.2). */
  applyConfig(cfg: ClaudeCodeConfig): void {
    this.cfg = cfg;
  }

  /** Build the full shell command line. `cfg.command` is itself a shell string (SPEC §5.3.6).
   *  A non-null `resumeId` adds `--resume` so continuation turns reuse the session. */
  buildCommand(resumeId?: string | null): string {
    const parts: string[] = [
      this.platform.normalizeCommand(this.cfg.command),
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
    return createSession(workspace);
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult> {
    // Continuation turns (those after the first) resume the established session
    // so the agent keeps its context (SPEC §7.1, §10.1).
    session.turnNumber += 1;
    const resumeId = session.turnNumber > 1 ? session.agentSessionId : null;
    // Per-turn accumulator: best-effort usage from assistant messages in case the
    // result line is killed before it is emitted (SPEC §10.1).
    const accum: TurnAccum = {
      inputTokens: 0,
      outputTokens: 0,
      resultSeen: false,
    };
    // Wrap onEvent to inject accumulated usage into the terminal event emitted by
    // runSubprocess when no result line arrived (timeout, kill, or crash). This
    // preserves the one-terminal-event-per-turn invariant while still surfacing
    // best-effort usage to the orchestrator.
    const wrappedOnEvent: AgentEventCallback = (event) => {
      if (
        !accum.resultSeen &&
        (event.event === "turn_cancelled" || event.event === "turn_failed") &&
        !event.usage &&
        (accum.inputTokens > 0 || accum.outputTokens > 0)
      ) {
        onEvent({
          ...event,
          usage: {
            inputTokens: accum.inputTokens,
            outputTokens: accum.outputTokens,
          },
        });
        return;
      }
      onEvent(event);
    };
    // Prompt is delivered on stdin to avoid argv length limits (SPEC §10.1).
    return runSubprocess(session, {
      command: this.buildCommand(resumeId),
      timeoutMs: this.cfg.turnTimeoutMs,
      stdin: prompt,
      onEvent: wrappedOnEvent,
      onLine: (line) => this.handleLine(session, line, wrappedOnEvent, accum),
      logger: this.logger,
      treeKiller: this.platform.treeKiller,
    });
  }

  /** Parse one stream-json line into normalized events; return the turn result when seen. */
  private handleLine(
    session: AgentSession,
    line: string,
    onEvent: AgentEventCallback,
    accum: TurnAccum,
  ): TurnResult | null {
    const msg = parseJsonLine(line, onEvent);
    if (msg === null) return null;
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init" && typeof msg.session_id === "string") {
          session.agentSessionId = msg.session_id;
          // session_started is emitted once, on the first turn, carrying the
          // composite id `<agent_session_id>-1`; continuation turns increment
          // turn_number instead of re-emitting (SPEC §10.1, §17.5).
          if (session.turnNumber <= 1) {
            onEvent({
              event: "session_started",
              timestamp: now(),
              payload: {
                session_id: `${msg.session_id}-${session.turnNumber}`,
              },
            });
          }
        } else {
          onEvent({ event: "other_message", timestamp: now() });
        }
        return null;
      }
      case "assistant": {
        // Accumulate best-effort usage from assistant messages. input_tokens grows
        // with context size so take the latest value; output_tokens is incremental
        // per API call so sum them. Matches what the result line would report.
        const msgObj = msg.message as
          | { content?: unknown; usage?: unknown }
          | undefined;
        const aUsage = readUsage(msgObj?.usage);
        if (aUsage) {
          accum.inputTokens = aUsage.inputTokens;
          accum.outputTokens += aUsage.outputTokens;
        }
        for (const event of summarizeAssistant(msg)) onEvent(event);
        return null;
      }
      case "result": {
        const ok = msg.is_error !== true;
        const usage = readUsage(msg.usage);
        accum.resultSeen = true;
        onEvent({
          event: ok ? "turn_completed" : "turn_failed",
          timestamp: now(),
          message:
            typeof msg.result === "string"
              ? msg.result.slice(0, ERROR_MESSAGE_MAX_BYTES)
              : undefined,
          ...(usage ? { usage } : {}),
        });
        return ok
          ? { ok: true }
          : {
              ok: false,
              error:
                typeof msg.result === "string"
                  ? msg.result.slice(0, ERROR_MESSAGE_MAX_BYTES)
                  : `result subtype=${String(msg.subtype)}`,
            };
      }
      default: {
        onEvent({ event: "other_message", timestamp: now() });
        return null;
      }
    }
  }

  async stopSession(session: AgentSession): Promise<void> {
    await stopSessionProcess(session, this.platform.treeKiller);
  }
}

interface TurnAccum {
  inputTokens: number;
  outputTokens: number;
  resultSeen: boolean;
}

function readUsage(
  v: unknown,
): { inputTokens: number; outputTokens: number } | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return { inputTokens: input, outputTokens: output };
}

function summarizeAssistant(msg: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = [];
  const message = msg.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === "text" && typeof block.text === "string") {
      events.push({
        event: "notification",
        timestamp: now(),
        message: block.text.slice(0, DISPLAY_TEXT_MAX_BYTES),
      });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      events.push({
        event: "tool_use",
        timestamp: now(),
        message: block.name,
      });
    }
  }
  if (events.length === 0) {
    events.push({ event: "other_message", timestamp: now() });
  }
  return events;
}
