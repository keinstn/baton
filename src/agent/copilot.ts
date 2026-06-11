import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { CopilotConfig } from "../config/schema.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { shellQuote } from "./claude-code.js";
import type {
  AgentEvent,
  AgentEventCallback,
  AgentRunner,
  AgentSession,
  TurnResult,
} from "./runner.js";

function now(): string {
  return new Date().toISOString();
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
    private readonly _logger: Logger,
  ) {}

  /** Apply a new config; takes effect on the next turn dispatch (SPEC §6.2). */
  applyConfig(cfg: CopilotConfig): void {
    this.cfg = cfg;
  }

  /** Build the full shell command line. `cfg.command` is itself a shell string
   *  (SPEC §5.3.7). `sessionId` is always set; `resume=true` resumes an existing
   *  session, `resume=false` creates a new session pinned to that id. */
  buildCommand(prompt: string, sessionId: string, resume: boolean): string {
    const parts: string[] = [
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
    if (this.cfg.allowAllTools) {
      parts.push("--allow-all-tools");
    }
    for (const tool of this.cfg.allowTools) {
      parts.push(`--allow-tool=${shellQuote(tool)}`);
    }
    for (const tool of this.cfg.denyTools) {
      parts.push(`--deny-tool=${shellQuote(tool)}`);
    }
    if (this.cfg.model) {
      parts.push("--model", shellQuote(this.cfg.model));
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
    return this.runProcess(session, prompt, fresh, false, onEvent);
  }

  private runProcess(
    session: AgentSession,
    prompt: string,
    sessionId: string,
    resume: boolean,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult> {
    return new Promise((resolvePromise) => {
      const cmdline = this.buildCommand(prompt, sessionId, resume);
      // detached: own process group, so timeout/stop kills the whole agent
      // process tree (not just the bash -lc wrapper).
      const proc = spawn("bash", ["-lc", cmdline], {
        cwd: session.workspace,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      session.proc = proc;

      let stderrTail = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });

      let result: TurnResult | null = null;
      let sessionStartedEmitted = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc);
      }, this.cfg.turnTimeoutMs);

      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        const r = this.handleLine(
          session,
          line,
          sessionStartedEmitted,
          onEvent,
        );
        if (r.sessionStarted) sessionStartedEmitted = true;
        if (r.result) result = r.result;
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

  /** Parse one JSONL line into normalized events. The first non-ephemeral line
   *  promotes to `session_started`; the terminal `result` row produces the
   *  TurnResult. */
  private handleLine(
    session: AgentSession,
    line: string,
    sessionStartedEmitted: boolean,
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
        message: trimmed.slice(0, 200),
      });
      return { result: null, sessionStarted: false };
    }
    const type = typeof msg.type === "string" ? msg.type : "";
    const data = (msg.data ?? {}) as Record<string, unknown>;

    // Emit session_started exactly once, on the first observed event after the
    // process started, carrying the composite id `<agent_session_id>-<turn>`
    // (SPEC §10.1 / §17.5). Continuation turns increment turn_number instead
    // of re-emitting.
    let didEmitSessionStart = false;
    if (
      !sessionStartedEmitted &&
      session.turnNumber <= 1 &&
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
            message: content.slice(0, 200),
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

// Suppress unused-symbol warning for AgentEvent (re-exported for adapter authors).
export type { AgentEvent };
