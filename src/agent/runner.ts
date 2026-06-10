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
