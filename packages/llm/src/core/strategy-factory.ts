import type { ModelConfig } from "@companion/config";
import { PROVIDERS } from "./provider-constants";
import type { LLMProviderStrategy } from "./public-types";
import { ProviderProfileRepository } from "./repositories/provider-profile-repository";
import { GeminiStrategy } from "./strategies/gemini-strategy";
import { OllamaStrategy } from "./strategies/ollama-strategy";
import { OpenAICompatibleStrategy } from "./strategies/openai-compatible-strategy";

export const createProviderStrategy = (cfg: ModelConfig): LLMProviderStrategy => {
  const profileRepository = new ProviderProfileRepository(cfg);

  if (cfg.provider === PROVIDERS.Ollama) {
    return new OllamaStrategy(profileRepository);
  }

  if (cfg.provider === PROVIDERS.Gemini) {
    return new GeminiStrategy(profileRepository);
  }

  return new OpenAICompatibleStrategy(profileRepository);
};
