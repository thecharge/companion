import { OpenAICompatibleAdapter } from "../adapters/openai-compatible-adapter";
import { ENDPOINTS } from "../provider-constants";
import type { ChatMessage, ChatParams, ChatResponse, LLMProviderStrategy } from "../public-types";
import { HttpRepository } from "../repositories/http-repository";
import type { ProviderProfileRepository } from "../repositories/provider-profile-repository";

export class OpenAICompatibleStrategy implements LLMProviderStrategy {
  private readonly adapter = new OpenAICompatibleAdapter();

  constructor(
    private readonly profileRepository: ProviderProfileRepository,
    private readonly httpRepository = new HttpRepository(),
  ) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    const profile = this.profileRepository.getProfile();
    const response = await this.httpRepository.postJson<ChatResponse>(`${profile.baseUrl}${ENDPOINTS.OAIChat}`, {
      headers: this.profileRepository.getJsonHeaders(),
      body: this.adapter.toChatBody(params, profile),
      timeoutMs: this.profileRepository.chatTimeout(),
      signal: params.signal,
    });
    return this.adapter.normalizeChatResponse(response, profile);
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    const profile = this.profileRepository.getProfile();
    const stream = await this.httpRepository.postStream(`${profile.baseUrl}${ENDPOINTS.OAIChat}`, {
      headers: this.profileRepository.getJsonHeaders(),
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
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const text = this.adapter.parseSseChunk(data);
            if (text) yield text;
          } catch {
            if (data.startsWith("{") && !data.endsWith("}")) {
              buffer = data;
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
    const data = await this.httpRepository.postJson<{ data: Array<{ embedding: number[] }> }>(
      `${profile.baseUrl}${ENDPOINTS.OAIEmbed}`,
      {
        headers: this.profileRepository.getJsonHeaders(),
        body: this.adapter.toEmbedBody(text, profile),
        timeoutMs: this.profileRepository.embedTimeout(),
      },
    );

    const embedding = data.data[0]?.embedding;
    if (!embedding) throw new Error("No embedding returned");
    return embedding;
  }
}
