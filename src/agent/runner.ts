import type { ChildProcess } from "node:child_process";

/** Normalized upstream event (SPEC §10.0). */
export interface AgentEvent {
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_input_required"
    | "permission_denied"
    | "tool_use"
    | "notification"
    | "other_message"
    | "malformed";
  timestamp: string;
  message?: string;
  usage?: { inputTokens: number; outputTokens: number };
  payload?: Record<string, unknown>;
}

export type AgentEventCallback = (event: AgentEvent) => void;

export interface AgentSession {
  workspace: string;
  agentSessionId: string | null;
  proc: ChildProcess | null;
  /** Resolves when the current subprocess has fully exited. Used so
   *  stopSession() can await real shutdown before after_run hooks or workspace
   *  cleanup proceed. */
  procClosed: Promise<void> | null;
  /** Force-settle an in-flight turn when a stop is requested but Windows has not
   *  delivered the child `close` event within the grace window after taskkill.
   *  Without it, aborting a running turn would block the worker on `runTurn`. */
  procForceClose: (() => void) | null;
  /** Count of turns already run on this session; the adapter increments it
   *  before each turn so continuation turns resume and skip session_started
   *  (SPEC §10.1). */
  turnNumber: number;
}

export interface TurnResult {
  ok: boolean;
  error?: string;
}

/** Agent adapter contract (SPEC §10.0). */
export interface AgentRunner {
  startSession(workspace: string): Promise<AgentSession>;
  runTurn(
    session: AgentSession,
    prompt: string,
    onEvent: AgentEventCallback,
  ): Promise<TurnResult>;
  stopSession(session: AgentSession): Promise<void>;
}
