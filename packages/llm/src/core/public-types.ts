import type { ModelConfig } from "@companion/config";

export type Provider = ModelConfig["provider"];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatChoice {
  message: ChatMessage;
  finish_reason: "stop" | "tool_calls" | "length" | null;
}

export interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: ChatChoice[];
  usage?: UsageStats;
}

export interface ChatParams {
  messages: ChatMessage[];
  tools?: OAITool[];
  tool_choice?: "auto" | "none" | "required";
  json_mode?: boolean;
  signal?: AbortSignal;
}

export interface LLMProviderStrategy {
  chat(params: ChatParams): Promise<ChatResponse>;
  stream(messages: ChatMessage[]): AsyncGenerator<string>;
  embed(text: string): Promise<number[]>;
}
