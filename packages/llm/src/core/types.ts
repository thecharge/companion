/**
 * @companion/llm
 *
 * Unified LLM client over the OpenAI wire format.
 * Supports: Anthropic, OpenAI, Ollama, Gemini, GitHub Copilot, Grok (xAI).
 *
 * All network calls use Bun's built-in fetch — no node-fetch, no axios.
 */

export type LLMTempByIncrement = 0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1;

export enum LLMMessagesRole {
  User = "user",
  Assistant = "assistant",
  System = "system",
}

export type LLMAssistantMessage = {
  role: LLMMessagesRole.Assistant;
  content: string;
};

export type LLMUserMessage = {
  role: LLMMessagesRole.User;
  content: string;
};

export type LLMSystemMessage = {
  role: LLMMessagesRole.System;
  content: string;
};

export type LLMMessage = LLMUserMessage | LLMAssistantMessage | LLMSystemMessage;

export interface LLMCompletionsRequest {
  model: string;
  messages: LLMMessage[];
  max_tokens?: number;
  temperature?: LLMTempByIncrement;
  top_p?: number;
  stream?: boolean;
}

export const LLMCompletionResponseFinishReasons = {
  Stop: "stop",
  Length: "length",
  ContentFilter: "content_filter",
  Null: "null",
} as const;
export type LLMCompletionResponseFinishReason =
  (typeof LLMCompletionResponseFinishReasons)[keyof typeof LLMCompletionResponseFinishReasons];

export type LLMCompletionResponseChoice = {
  index: number;
  message: LLMAssistantMessage;
  finish_reason?: LLMCompletionResponseFinishReason;
};

export interface LLMCompletionsResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: LLMCompletionResponseChoice[];
}

export type LLMStreamChunkChoice = {
  index: number;
  delta: LLMAssistantMessage;
  finish_reason?: LLMCompletionResponseFinishReason;
};

export interface LLMStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: LLMStreamChunkChoice[];
}
