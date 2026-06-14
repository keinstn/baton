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
  /** Resolves when the current subprocess has fully exited or the OS confirms
   *  it has been terminated. Used so stopSession() can await real shutdown
   *  before after_run hooks or workspace cleanup proceed. */
  procClosed: Promise<void> | null;
  /** Best-effort force-settle for an in-flight turn when the OS confirms the
   *  process tree was killed but Node never delivers a child `close` event. */
  procForceClose: (() => void) | null;
  /** Whether Baton has already received a successful Windows tree-kill
   *  confirmation for the current subprocess. This lets later shutdown paths
   *  distinguish "wrapper PID is gone" from "the full agent tree was killed". */
  procTreeKillConfirmed: boolean;
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
