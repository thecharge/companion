import type { ModelConfig } from "@companion/config";
import type { ChatMessage, ChatParams, ChatResponse, LLMProviderStrategy } from "./public-types";
import { createProviderStrategy } from "./strategy-factory";

export class LLMClientFacade {
  private readonly strategy: LLMProviderStrategy;

  constructor(cfg: ModelConfig, strategy?: LLMProviderStrategy) {
    this.strategy = strategy ?? createProviderStrategy(cfg);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    return this.strategy.chat(params);
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    yield* this.strategy.stream(messages);
  }

  async embed(text: string): Promise<number[]> {
    return this.strategy.embed(text);
  }
}
