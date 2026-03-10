import { MODEL_NO_TOOL_PATTERNS, PROVIDERS } from "./provider-constants";
import type { ChatMessage, ChatResponse, Provider } from "./public-types";

export function firstChoice(res: ChatResponse): ChatMessage {
  const choice = res.choices[0];
  if (!choice) throw new Error("LLM returned no choices");
  return choice.message;
}

export function isToolCall(msg: ChatMessage): boolean {
  return Boolean(msg.tool_calls?.length);
}

export function modelSupportsTools(model: string): boolean {
  const lower = model.toLowerCase();
  return !MODEL_NO_TOOL_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function stripThinking(content: string | null): { text: string; thinking: string } {
  if (!content) return { text: "", thinking: "" };
  const match = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (match) return { thinking: (match[1] ?? "").trim(), text: content.slice(match[0].length).trim() };
  return { text: content, thinking: "" };
}

export function isOllama(provider: string): boolean {
  return provider === PROVIDERS.Ollama;
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

export function parseJsonOrDefault<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function newResponseId(provider: Provider): string {
  return `${provider}-${Date.now()}`;
}

export function newToolCallId(index: number): string {
  return `call_${Date.now()}_${index}`;
}
