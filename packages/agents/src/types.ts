import type { Blackboard, SessionId } from "@companion/core";
import type { ChatMessage } from "@companion/llm";

export interface AgentRunParams {
  session_id: SessionId;
  blackboard: Blackboard;
  user_message: string;
  history: ChatMessage[];
  working_dir: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  reply: string;
  blackboard: Blackboard;
  stopped_reason: "done" | "max_turns" | "error" | "cancelled";
}

export interface OrchestratorParams {
  session_id: SessionId;
  blackboard: Blackboard;
  user_message: string;
  history: ChatMessage[];
  working_dir: string;
  mode: string;
  signal?: AbortSignal;
}
