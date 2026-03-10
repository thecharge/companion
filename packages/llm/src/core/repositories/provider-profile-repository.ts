import type { ModelConfig } from "@companion/config";
import { trimTrailingSlash } from "../helpers";
import {
  CONTENT_TYPES,
  HEADER_KEYS,
  PROVIDERS,
  PROVIDER_DEFAULT_BASE_URL,
  REQUEST_TIMEOUT_MS,
} from "../provider-constants";
import type { Provider } from "../public-types";

export interface ProviderProfile {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
}

export class ProviderProfileRepository {
  constructor(private readonly cfg: ModelConfig) {}

  getProfile(): ProviderProfile {
    return {
      provider: this.cfg.provider,
      model: this.cfg.model,
      apiKey: this.cfg.api_key ?? "",
      baseUrl: this.getBaseUrl(),
      temperature: this.cfg.temperature,
      maxTokens: this.cfg.max_tokens,
    };
  }

  getBaseUrl(): string {
    if (this.cfg.base_url) {
      return trimTrailingSlash(this.cfg.base_url);
    }
    return PROVIDER_DEFAULT_BASE_URL[this.cfg.provider];
  }

  getAuthHeaders(): Record<string, string> {
    const apiKey = this.cfg.api_key ?? "";

    switch (this.cfg.provider) {
      case PROVIDERS.Anthropic:
        return {
          [HEADER_KEYS.ApiKey]: apiKey,
          [HEADER_KEYS.AnthropicVersion]: "2023-06-01",
        };
      case PROVIDERS.Copilot:
      case PROVIDERS.OpenAI:
      case PROVIDERS.Grok:
        return apiKey ? { [HEADER_KEYS.Authorization]: `Bearer ${apiKey}` } : {};
      default:
        return {};
    }
  }

  getJsonHeaders(includeAuth = true): Record<string, string> {
    return {
      [HEADER_KEYS.ContentType]: CONTENT_TYPES.Json,
      ...(includeAuth ? this.getAuthHeaders() : {}),
    };
  }

  chatTimeout(): number {
    return REQUEST_TIMEOUT_MS.Chat;
  }

  streamTimeout(): number {
    return REQUEST_TIMEOUT_MS.Stream;
  }

  embedTimeout(): number {
    return REQUEST_TIMEOUT_MS.Embed;
  }
}
