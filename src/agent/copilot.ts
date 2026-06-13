import { randomUUID } from "node:crypto";
import type { CopilotConfig } from "../config/schema.js";
import { DISPLAY_TEXT_MAX_BYTES } from "../constants.js";
import type { Logger } from "../observability/logger.js";
import { now } from "../util.js";
import {
  ensureWorkspaceDir,
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Default upper bound on prompt argv bytes. The GitHub Copilot CLI accepts
 * prompts only via `-p <text>` (no stdin input, no file flag), so prompts
 * larger than this fail the turn rather than risking ARG_MAX truncation
 * (typical kernel ARG_MAX is 256 KiB on macOS / 2 MiB on Linux).
 */
const DEFAULT_PROMPT_MAX_BYTES = 128 * 1024;

/**
 * GitHub Copilot CLI adapter, programmatic mode (SPEC §10.2).
 *
 * One outer turn per `copilot -p ...` invocation with `--output-format json`
 * (JSONL). The CLI does not support stdin prompts, so prompts are passed via
 * argv and length-checked. Continuation turns reuse the session by passing the
 * UUID we set on the first turn (`--session-id <uuid>`) as `--resume <uuid>`
 * on subsequent turns. If a resume turn exits non-zero, the runner makes one
 * fresh-session retry inside the same turn — fulfilling the SPEC §10.2
 * contract that resume support is best-effort.
 *
 * Token usage is reported as zero: the CLI's `result.usage` payload exposes
 * premium-request and duration metrics but not absolute input/output token
 * counts, and SPEC §10.2 forbids fabricating those.
 */
export class CopilotRunner implements AgentRunner {
  constructor(
    private cfg: CopilotConfig,
    private readonly logger?: Logger,
  ) {}

  /** Apply a new config; takes effect on the next turn dispatch (SPEC §6.2). */
  applyConfig(cfg: CopilotConfig): void {
    this.cfg = cfg;
  }

  /**
   * Build the command for the agent process (SPEC §5.3.7).
   * Returns a shell string when cfg.command is a string (spawned via bash -lc),
   * or a string[] argv when cfg.command is a string[] (spawned directly).
   * `sessionId` is always set; `resume=true` resumes an existing session.
   */
  buildCommand(
    prompt: string,
    sessionId: string,
    resume: boolean,
  ): string | string[] {
    if (typeof this.cfg.command === "string") {
      const parts = [
        this.cfg.command,
        "-p",
        shellQuote(prompt),
        "--output-format",
        "json",
        "--no-ask-user",
        "--log-level",
        "none",
      ];
      if (resume) {
        parts.push("--resume", shellQuote(sessionId));
      } else {
        parts.push("--session-id", shellQuote(sessionId));
      }
      if (this.cfg.allowAllTools) parts.push("--allow-all-tools");
      for (const tool of this.cfg.allowTools)
        parts.push(`--allow-tool=${shellQuote(tool)}`);
      for (const tool of this.cfg.denyTools)
        parts.push(`--deny-tool=${shellQuote(tool)}`);
      if (this.cfg.model) parts.push("--model", shellQuote(this.cfg.model));
      parts.push(...this.cfg.extraArgs.map(shellQuote));
      return parts.join(" ");
    } else {
      const parts: string[] = [
        ...this.cfg.command,
        "-p",
        prompt,
        "--output-format",
        "json",
        "--no-ask-user",
        "--log-level",
        "none",
      ];
      if (resume) {
        parts.push("--resume", sessionId);
      } else {
        parts.push("--session-id", sessionId);
      }
      if (this.cfg.allowAllTools) parts.push("--allow-all-tools");
      for (const tool of this.cfg.allowTools)
        parts.push(`--allow-tool=${tool}`);
      for (const tool of this.cfg.denyTools) parts.push(`--deny-tool=${tool}`);
      if (this.cfg.model) parts.push("--model", this.cfg.model);
      parts.push(...this.cfg.extraArgs);
      return parts;
    }
  }

  async startSession(workspace: string): Promise<AgentSession> {
    await ensureWorkspaceDir(workspace);
    return { workspace, agentSessionId: null, proc: null, turnNumber: 0 };
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult> {
    session.turnNumber += 1;

    // SPEC §10.2: prompt has to fit in argv. Fail fast on oversized prompts
    // rather than producing a truncated CLI invocation.
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > DEFAULT_PROMPT_MAX_BYTES) {
      const error = `prompt_too_long: ${promptBytes} bytes > ${DEFAULT_PROMPT_MAX_BYTES}`;
      onEvent({ event: "turn_failed", timestamp: now(), message: error });
      return { ok: false, error };
    }

    // First turn: pre-assign a UUID via --session-id so continuation turns can
    // resume. Continuation turns: --resume the same UUID. (SPEC §10.1, §10.2)
    if (session.agentSessionId === null) {
      session.agentSessionId = randomUUID();
    }
    const isFirstTurn = session.turnNumber === 1;
    const result = await this.runProcess(
      session,
      prompt,
      session.agentSessionId,
      !isFirstTurn,
      onEvent,
      isFirstTurn,
    );
    if (result.ok || isFirstTurn) return result;

    // Resume failure fallback: rotate the session id and retry once as a fresh
    // session in the same workspace (SPEC §10.2 documents this fallback).
    const fresh = randomUUID();
    onEvent({
      event: "notification",
      timestamp: now(),
      message: `resume failed; retrying with fresh session ${fresh}`,
    });
    session.agentSessionId = fresh;
    return this.runProcess(session, prompt, fresh, false, onEvent, true);
  }

  private runProcess(
    session: AgentSession,
    prompt: string,
    sessionId: string,
    resume: boolean,
    onEvent: AgentEventCallback,
    /** True when this process represents a brand-new agent session (first turn
     *  or fresh-session fallback). Controls whether `session_started` can be
     *  emitted regardless of `session.turnNumber`. */
    isNewSession = false,
  ): Promise<TurnResult> {
    // The Copilot CLI takes prompts via argv (no stdin), so stdio in is ignored.
    let sessionStartedEmitted = false;
    return runSubprocess(session, {
      command: this.buildCommand(prompt, sessionId, resume),
      timeoutMs: this.cfg.turnTimeoutMs,
      onEvent,
      onLine: (line) => {
        const r = this.handleLine(
          session,
          line,
          sessionStartedEmitted,
          isNewSession,
          onEvent,
        );
        if (r.sessionStarted) sessionStartedEmitted = true;
        return r.result;
      },
      logger: this.logger,
    });
  }

  /** Parse one JSONL line into normalized events. `isNewSession` is true when
   *  this `runProcess` call represents a brand-new agent session (first turn or
   *  fresh-session fallback), allowing `session_started` to be emitted even on
   *  continuation turn numbers (SPEC §10.2). */
  private handleLine(
    session: AgentSession,
    line: string,
    sessionStartedEmitted: boolean,
    isNewSession: boolean,
    onEvent: AgentEventCallback,
  ): { result: TurnResult | null; sessionStarted: boolean } {
    const trimmed = line.trim();
    if (trimmed === "") return { result: null, sessionStarted: false };
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      onEvent({
        event: "malformed",
        timestamp: now(),
        message: trimmed.slice(0, DISPLAY_TEXT_MAX_BYTES),
      });
      return { result: null, sessionStarted: false };
    }
    const type = typeof msg.type === "string" ? msg.type : "";
    const data = (msg.data ?? {}) as Record<string, unknown>;

    // Emit session_started exactly once per new agent session, carrying the
    // composite id `<agent_session_id>-<turn>` (SPEC §10.1 / §17.5).
    // `isNewSession` is true for the first turn AND for fresh-session fallback
    // retries so that each distinct agent session always gets one event.
    // Normal continuation turns (resume) set isNewSession=false to suppress
    // re-emission.
    let didEmitSessionStart = false;
    if (
      !sessionStartedEmitted &&
      isNewSession &&
      session.agentSessionId !== null
    ) {
      onEvent({
        event: "session_started",
        timestamp: now(),
        payload: {
          session_id: `${session.agentSessionId}-${session.turnNumber}`,
        },
      });
      didEmitSessionStart = true;
    }

    switch (type) {
      case "tool.execution_start": {
        const name =
          typeof data.toolName === "string" ? data.toolName : "unknown";
        onEvent({ event: "tool_use", timestamp: now(), message: name });
        return { result: null, sessionStarted: didEmitSessionStart };
      }
      case "tool.execution_complete": {
        if (data.success === false) {
          const name =
            typeof data.toolName === "string" ? data.toolName : "unknown";
          onEvent({
            event: "notification",
            timestamp: now(),
            message: `tool_failed: ${name}`,
          });
        }
        return { result: null, sessionStarted: didEmitSessionStart };
      }
      case "assistant.message": {
        const content = typeof data.content === "string" ? data.content : "";
        if (content.length > 0) {
          onEvent({
            event: "notification",
            timestamp: now(),
            message: content.slice(0, DISPLAY_TEXT_MAX_BYTES),
          });
        }
        return { result: null, sessionStarted: didEmitSessionStart };
      }
      case "assistant.turn_start": {
        // Heartbeat for stall detection (SPEC §10.2, §10.3).
        onEvent({ event: "notification", timestamp: now() });
        return { result: null, sessionStarted: didEmitSessionStart };
      }
      case "result": {
        const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : 1;
        const ok = exitCode === 0;
        // SPEC §10.2: usage is reported as zero — the CLI's result.usage carries
        // request/duration metrics, not token counts, and we MUST NOT fabricate.
        onEvent({
          event: ok ? "turn_completed" : "turn_failed",
          timestamp: now(),
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        return {
          result: ok
            ? { ok: true }
            : { ok: false, error: `exit_code=${exitCode}` },
          sessionStarted: didEmitSessionStart,
        };
      }
      default: {
        // Ephemeral session.* / message_start / message_delta / turn_end land
        // here. Skipping them silently keeps logs readable — the explicit
        // events above are sufficient for stall detection.
        return { result: null, sessionStarted: didEmitSessionStart };
      }
    }
  }

  async stopSession(session: AgentSession): Promise<void> {
    stopSessionProcess(session);
  }
}

// Suppress unused-symbol warning for AgentEvent (re-exported for adapter authors).
export type { AgentEvent };
