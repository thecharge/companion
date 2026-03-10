import type { Provider } from "./public-types";

export const PROVIDERS = {
  Ollama: "ollama",
  Anthropic: "anthropic",
  OpenAI: "openai",
  Gemini: "gemini",
  Copilot: "copilot",
  Grok: "grok",
} as const;

export const PROVIDER_DEFAULT_BASE_URL: Record<Provider, string> = {
  [PROVIDERS.Ollama]: "http://localhost:11434",
  [PROVIDERS.Anthropic]: "https://api.anthropic.com/v1",
  [PROVIDERS.OpenAI]: "https://api.openai.com/v1",
  [PROVIDERS.Gemini]: "https://generativelanguage.googleapis.com/v1beta",
  [PROVIDERS.Copilot]: "https://api.githubcopilot.com",
  [PROVIDERS.Grok]: "https://api.x.ai/v1",
};

export const REQUEST_TIMEOUT_MS = {
  Chat: 180_000,
  Stream: 300_000,
  Embed: 30_000,
  Probe: 3_000,
} as const;

export const ENDPOINTS = {
  OAIChat: "/chat/completions",
  OAIEmbed: "/embeddings",
  OllamaChat: "/api/chat",
  OllamaEmbed: "/api/embeddings",
  GeminiGenerate: "generateContent",
  GeminiStream: "streamGenerateContent",
  GeminiEmbed: "embedContent",
} as const;

export const MODEL_NO_TOOL_PATTERNS = [
  "qwen3:1.7b",
  "qwen:3b",
  "phi3:mini",
  "tinyllama",
  "gemma:2b",
  "qwen2.5:1b",
] as const;

export const HEADER_KEYS = {
  Authorization: "Authorization",
  ContentType: "Content-Type",
  ApiKey: "x-api-key",
  AnthropicVersion: "anthropic-version",
} as const;

export const CONTENT_TYPES = {
  Json: "application/json",
} as const;
