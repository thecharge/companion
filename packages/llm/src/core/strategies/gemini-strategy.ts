import { GeminiAdapter } from "../adapters/gemini-adapter";
import type { ChatMessage, ChatParams, ChatResponse, LLMProviderStrategy } from "../public-types";
import { HttpRepository } from "../repositories/http-repository";
import type { ProviderProfileRepository } from "../repositories/provider-profile-repository";

export class GeminiStrategy implements LLMProviderStrategy {
  private readonly adapter = new GeminiAdapter();

  constructor(
    private readonly profileRepository: ProviderProfileRepository,
    private readonly httpRepository = new HttpRepository(),
  ) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    const profile = this.profileRepository.getProfile();
    const data = await this.httpRepository.postJson<Record<string, unknown>>(this.adapter.endpoint(profile), {
      headers: this.profileRepository.getJsonHeaders(false),
      body: this.adapter.toChatBody(params, profile),
      timeoutMs: this.profileRepository.chatTimeout(),
      signal: params.signal,
    });

    return this.adapter.normalizeChatResponse(data, profile);
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    const profile = this.profileRepository.getProfile();
    const stream = await this.httpRepository.postStream(this.adapter.endpoint(profile, true), {
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
          const trimmed = line.trim();
          if (!trimmed || trimmed === "[" || trimmed === "]" || trimmed === ",") continue;
          try {
            const chunk = JSON.parse(trimmed) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
            const text = chunk.candidates[0]?.content?.parts.map((part) => part.text).join("") ?? "";
            if (text) yield text;
          } catch {
            if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
              buffer = `${trimmed}\n`;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(text: string): Promise<number[]> {
    const profile = this.profileRepository.getProfile();
    const data = await this.httpRepository.postJson<{ embedding: { values: number[] } }>(
      this.adapter.embedEndpoint(profile),
      {
        headers: this.profileRepository.getJsonHeaders(false),
        body: this.adapter.toEmbedBody(text, profile),
        timeoutMs: this.profileRepository.embedTimeout(),
      },
    );

    return data.embedding.values;
  }
}
