/**
 * @companion/llm
 *
 * Unified LLM client over the OpenAI wire format.
 * Supports: Anthropic, OpenAI, Ollama, Gemini, GitHub Copilot.
 *
 * All network calls use Bun's built-in fetch — no node-fetch, no axios.
 */

import type { ModelConfig } from "@companion/config";

// ── Public types ──────────────────────────────────────────────

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
  signal?: AbortSignal; // cancel mid-flight
}

// ── Helpers ───────────────────────────────────────────────────

function firstChoice(res: ChatResponse): ChatMessage {
  const choice = res.choices[0];
  if (!choice) throw new Error("LLM returned no choices");
  return choice.message;
}

export function isToolCall(msg: ChatMessage): boolean {
  return !!msg.tool_calls?.length;
}

export function modelSupportsTools(model: string): boolean {
  const lower = model.toLowerCase();
  // qwen3 (all sizes) — native tool calling via Ollama /api/chat tools param.
  // Block only models confirmed to NOT support structured tool calls.
  const noTools = ["qwen2.5:3b", "qwen:3b", "phi3:mini", "tinyllama", "gemma:2b", "qwen2.5:1b"];
  return !noTools.some((m) => lower.includes(m));
}

/** Strip Qwen3 <think>...</think> blocks. Returns text and extracted thinking. */
export function stripThinking(content: string | null): { text: string; thinking: string } {
  if (!content) return { text: "", thinking: "" };
  const m = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (m) return { thinking: (m[1] ?? "").trim(), text: content.slice(m[0].length).trim() };
  return { text: content, thinking: "" };
}

export function isOllama(provider: string): boolean {
  return provider === "ollama";
}

// ── LLMClient ─────────────────────────────────────────────────

export class LLMClient {
  constructor(private cfg: ModelConfig) {}

  /** Non-streaming chat — returns full response */
  async chat(params: ChatParams): Promise<ChatResponse> {
    switch (this.cfg.provider) {
      case "ollama":
        return this.ollamaChat(params);
      case "gemini":
        return this.geminiChat(params);
      default:
        return this.oaiChat(params);
    }
  }

  /** Streaming chat — yields text chunks */
  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    switch (this.cfg.provider) {
      case "ollama":
        yield* this.ollamaStream(messages);
        break;
      case "gemini":
        yield* this.geminiStream(messages);
        break;
      default:
        yield* this.oaiStream(messages);
        break;
    }
  }

  /** Embeddings — returns float array */
  async embed(text: string): Promise<number[]> {
    switch (this.cfg.provider) {
      case "ollama":
        return this.ollamaEmbed(text);
      case "gemini":
        return this.geminiEmbed(text);
      default:
        return this.oaiEmbed(text);
    }
  }

  // ── Ollama native API (/api/chat) ─────────────────────────────
  // Uses the native Ollama endpoint which is available on all versions.
  // The /v1/chat/completions OpenAI-compat endpoint requires Ollama ≥ 0.1.24
  // and is not guaranteed to be present.

  private ollamaBase(): string {
    const configured = this.cfg.base_url?.replace(/\/$/, "");
    if (configured) {
      // If the user has explicitly set base_url to the /v1 compat path, strip it
      return configured.replace(/\/v1$/, "");
    }
    return "http://localhost:11434";
  }

  private toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.flatMap((m) => {
      if (m.role === "tool") {
        return [{ role: "tool", content: m.content ?? "", tool_call_id: m.tool_call_id }];
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        return [
          {
            role: "assistant",
            content: m.content ?? "",
            tool_calls: m.tool_calls.map((tc) => ({
              function: {
                name: tc.function.name,
                arguments: (() => {
                  try {
                    return JSON.parse(tc.function.arguments) as unknown;
                  } catch {
                    return tc.function.arguments;
                  }
                })(),
              },
            })),
          },
        ];
      }
      return [{ role: m.role, content: m.content ?? "" }];
    });
  }

  private async ollamaChat(params: ChatParams): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.toOllamaMessages(params.messages),
      stream: false,
      options: {
        temperature: this.cfg.temperature,
        num_predict: this.cfg.max_tokens,
      },
    };

    // Pass tools natively — Ollama /api/chat supports the OpenAI tools param
    // for all tool-capable models (qwen3 all sizes, llama3.1+, mistral3+, etc.)
    if (params.tools?.length) {
      body["tools"] = params.tools;
    }

    // json_mode only when no tools — they conflict
    if (params.json_mode && !params.tools?.length) {
      body["format"] = "json";
    }

    const res = await fetch(`${this.ollamaBase()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal ?? AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status} (${this.cfg.model}): ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const msg = data.message;
    const usage = {
      prompt_tokens: data.prompt_eval_count ?? 0,
      completion_tokens: data.eval_count ?? 0,
      total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };

    // Native tool calls — Ollama returns arguments as an object, OAI expects a string
    if (msg.tool_calls?.length) {
      return {
        id: `ollama-${Date.now()}`,
        model: this.cfg.model,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: msg.content ?? null,
              tool_calls: msg.tool_calls.map((tc, i) => ({
                id: `call_${Date.now()}_${i}`,
                type: "function" as const,
                function: {
                  name: tc.function.name,
                  arguments:
                    typeof tc.function.arguments === "string"
                      ? tc.function.arguments
                      : JSON.stringify(tc.function.arguments),
                },
              })),
            },
          },
        ],
        usage,
      };
    }

    // Strip <think> blocks from Qwen3 reasoning output
    const { text: stripped } = stripThinking(msg.content);
    return {
      id: `ollama-${Date.now()}`,
      model: this.cfg.model,
      choices: [{ message: { role: "assistant", content: stripped || msg.content }, finish_reason: "stop" }],
      usage,
    };
  }

  private async *ollamaStream(messages: ChatMessage[]): AsyncGenerator<string> {
    const res = await fetch(`${this.ollamaBase()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: this.toOllamaMessages(messages),
        stream: true,
        options: { temperature: this.cfg.temperature, num_predict: this.cfg.max_tokens },
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama stream ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
            if (chunk.message?.content) yield chunk.message.content;
            if (chunk.done) return;
          } catch {
            /* partial line */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── OpenAI-compatible (Anthropic, OpenAI, Copilot) ───────────

  private baseUrl(): string {
    if (this.cfg.base_url) return this.cfg.base_url.replace(/\/$/, "");
    switch (this.cfg.provider) {
      case "anthropic":
        return "https://api.anthropic.com/v1";
      case "openai":
        return "https://api.openai.com/v1";
      case "copilot":
        return "https://api.githubcopilot.com";
      default:
        return "https://api.openai.com/v1";
    }
  }

  private authHeaders(): Record<string, string> {
    const key = this.cfg.api_key ?? "";
    switch (this.cfg.provider) {
      case "anthropic":
        return {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        };
      case "copilot":
        return { Authorization: `Bearer ${key}` };
      default:
        return key ? { Authorization: `Bearer ${key}` } : {};
    }
  }

  private async oaiChat(params: ChatParams): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: params.messages,
      max_tokens: this.cfg.max_tokens,
      temperature: this.cfg.temperature,
    };

    if (params.tools?.length) {
      body["tools"] = params.tools;
      body["tool_choice"] = params.tool_choice ?? "auto";
    }

    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: params.signal ?? AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status} (${this.cfg.provider}/${this.cfg.model}): ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<ChatResponse>;
  }

  private async *oaiStream(messages: ChatMessage[]): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        max_tokens: this.cfg.max_tokens,
        temperature: this.cfg.temperature,
        stream: true,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM stream ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const chunk = JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> };
            const text = chunk.choices[0]?.delta?.content;
            if (text) yield text;
          } catch (e) {
            // Partial frame — accumulate and let next read complete it
            if (data.startsWith("{") && !data.endsWith("}")) {
              buf = data;
            } else {
              console.warn(`[llm] SSE parse warning: ${String(e).slice(0, 60)}`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async oaiEmbed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl()}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ model: this.cfg.model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Embed ${res.status}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const emb = data.data[0]?.embedding;
    if (!emb) throw new Error("No embedding returned");
    return emb;
  }

  // ── Ollama embeddings ─────────────────────────────────────

  private async ollamaEmbed(text: string): Promise<number[]> {
    const base = (this.cfg.base_url ?? "http://localhost:11434").replace(/\/$/, "");
    // /api/embed is the current endpoint (/api/embeddings is deprecated since Ollama 0.2)
    const res = await fetch(`${base}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text().catch(() => "")}`);
    const data = (await res.json()) as { embeddings?: number[][]; embedding?: number[] };
    // /api/embed returns { embeddings: [[...]] }; old endpoint returned { embedding: [...] }
    const vec = data.embeddings?.[0] ?? data.embedding;
    if (!vec?.length) throw new Error("Ollama embed: empty vector returned");
    return vec;
  }

  // ── Gemini ────────────────────────────────────────────────

  private geminiEndpoint(stream = false): string {
    const base = (this.cfg.base_url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const key = this.cfg.api_key ? `?key=${this.cfg.api_key}` : "";
    const action = stream ? "streamGenerateContent" : "generateContent";
    return `${base}/models/${this.cfg.model}:${action}${key}`;
  }

  private toGeminiContents(messages: ChatMessage[]): Array<{ role: string; parts: unknown[] }> {
    const contents: Array<{ role: string; parts: unknown[] }> = [];

    for (const m of messages) {
      // System → user/model ping-pong (Gemini REST API workaround)
      // TODO: migrate to top-level systemInstruction when API stabilises
      // Ref: https://ai.google.dev/gemini-api/docs/system-instructions
      if (m.role === "system") {
        contents.push({ role: "user", parts: [{ text: `[System]: ${m.content ?? ""}` }] });
        contents.push({ role: "model", parts: [{ text: "Understood." }] });
        continue;
      }

      // OpenAI tool result → Gemini functionResponse
      if (m.role === "tool") {
        let responseObj: Record<string, unknown>;
        try {
          responseObj = JSON.parse(m.content ?? "{}") as Record<string, unknown>;
        } catch {
          responseObj = { result: m.content ?? "" };
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.name ?? m.tool_call_id ?? "unknown_tool",
                response: responseObj,
              },
            },
          ],
        });
        continue;
      }

      // OpenAI assistant tool_calls → Gemini functionCall parts
      if (m.role === "assistant" && m.tool_calls?.length) {
        contents.push({
          role: "model",
          parts: m.tool_calls.map((tc) => ({
            functionCall: {
              name: tc.function.name,
              args: (() => {
                try {
                  return JSON.parse(tc.function.arguments) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })(),
            },
          })),
        });
        continue;
      }

      const role = m.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: [{ text: m.content ?? "" }] });
    }

    return contents;
  }

  private async geminiChat(params: ChatParams): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      contents: this.toGeminiContents(params.messages),
      generationConfig: { temperature: this.cfg.temperature, maxOutputTokens: this.cfg.max_tokens },
    };

    if (params.tools?.length) {
      body["tools"] = [
        {
          functionDeclarations: params.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
      body["toolConfig"] = { functionCallingConfig: { mode: "AUTO" } };
    }

    const res = await fetch(this.geminiEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const cands = data["candidates"] as Array<Record<string, unknown>> | undefined;
    const parts =
      ((cands?.[0]?.["content"] as Record<string, unknown> | undefined)?.["parts"] as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
    const usage = data["usageMetadata"] as { promptTokenCount: number; candidatesTokenCount: number } | undefined;

    const usageOut = usage
      ? {
          prompt_tokens: usage.promptTokenCount,
          completion_tokens: usage.candidatesTokenCount,
          total_tokens: usage.promptTokenCount + usage.candidatesTokenCount,
        }
      : undefined;

    // functionCall parts → OpenAI tool_calls
    const fnCalls = parts.filter((p) => p["functionCall"]);
    if (fnCalls.length) {
      return {
        id: `gemini-${Date.now()}`,
        model: this.cfg.model,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: fnCalls.map((p, i) => ({
                id: `call_${Date.now()}_${i}`,
                type: "function" as const,
                function: {
                  name: String((p["functionCall"] as Record<string, unknown>)["name"]),
                  arguments: JSON.stringify((p["functionCall"] as Record<string, unknown>)["args"] ?? {}),
                },
              })),
            },
          },
        ],
        usage: usageOut,
      };
    }

    const text = parts
      .filter((p) => p["text"])
      .map((p) => String(p["text"]))
      .join("");
    return {
      id: `gemini-${Date.now()}`,
      model: this.cfg.model,
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: usageOut,
    };
  }

  private async *geminiStream(messages: ChatMessage[]): AsyncGenerator<string> {
    const body = {
      contents: this.toGeminiContents(messages),
      generationConfig: { temperature: this.cfg.temperature, maxOutputTokens: this.cfg.max_tokens },
    };

    const res = await fetch(this.geminiEndpoint(true), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini stream ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "[" || trimmed === "]" || trimmed === ",") continue;
          try {
            const chunk = JSON.parse(trimmed) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
            const text = chunk.candidates[0]?.content?.parts.map((p) => p.text).join("") ?? "";
            if (text) yield text;
          } catch (e) {
            if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
              buf = trimmed + "\n";
            } else {
              console.warn(`[llm] Gemini stream parse warning: ${String(e).slice(0, 60)}`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async geminiEmbed(text: string): Promise<number[]> {
    const base = (this.cfg.base_url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const key = this.cfg.api_key ? `?key=${this.cfg.api_key}` : "";
    const res = await fetch(`${base}/models/${this.cfg.model}:embedContent${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, content: { parts: [{ text }] } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Gemini embed ${res.status}`);
    const data = (await res.json()) as { embedding: { values: number[] } };
    return data.embedding.values;
  }
}

// ── Factory ───────────────────────────────────────────────────

export function createLLMClient(cfg: ModelConfig): LLMClient {
  return new LLMClient(cfg);
}

export { firstChoice };
