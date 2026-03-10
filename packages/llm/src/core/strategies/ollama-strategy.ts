import { OllamaAdapter } from "../adapters/ollama-adapter";
import type { ChatMessage, ChatParams, ChatResponse, LLMProviderStrategy } from "../public-types";
import { HttpRepository } from "../repositories/http-repository";
import type { ProviderProfileRepository } from "../repositories/provider-profile-repository";

export class OllamaStrategy implements LLMProviderStrategy {
  private readonly adapter = new OllamaAdapter();

  constructor(
    private readonly profileRepository: ProviderProfileRepository,
    private readonly httpRepository = new HttpRepository(),
  ) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    const profile = this.profileRepository.getProfile();
    const data = await this.httpRepository.postJson<{
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    }>(this.adapter.chatUrl(profile), {
      headers: this.profileRepository.getJsonHeaders(false),
      body: this.adapter.toChatBody(params, profile),
      timeoutMs: this.profileRepository.chatTimeout(),
      signal: params.signal,
    });

    return this.adapter.normalizeChatResponse(data, profile);
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    const profile = this.profileRepository.getProfile();
    const stream = await this.httpRepository.postStream(this.adapter.chatUrl(profile), {
      headers: this.profileRepository.getJsonHeaders(false),
      body: this.adapter.toStreamBody(messages, profile),
      timeoutMs: this.profileRepository.streamTimeout(),
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
            if (chunk.message?.content) yield chunk.message.content;
            if (chunk.done) return;
          } catch {
            // partial chunk
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(text: string): Promise<number[]> {
    const profile = this.profileRepository.getProfile();
    const data = await this.httpRepository.postJson<{ embedding: number[] }>(this.adapter.embedUrl(profile), {
      headers: this.profileRepository.getJsonHeaders(false),
      body: this.adapter.toEmbedBody(text, profile),
      timeoutMs: this.profileRepository.embedTimeout(),
    });

    return data.embedding;
  }
}
