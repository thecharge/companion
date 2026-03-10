import { newResponseId } from "../helpers";
import type { ChatMessage, ChatParams, ChatResponse } from "../public-types";
import type { ProviderProfile } from "../repositories/provider-profile-repository";

interface OAIChunk {
  choices: Array<{ delta: { content?: string } }>;
}

export class OpenAICompatibleAdapter {
  toChatBody(params: ChatParams, profile: ProviderProfile): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: params.messages,
      max_tokens: profile.maxTokens,
      temperature: profile.temperature,
    };

    if (params.tools?.length) {
      body.tools = params.tools;
      body.tool_choice = params.tool_choice ?? "auto";
    }

    return body;
  }

  toStreamBody(messages: ChatMessage[], profile: ProviderProfile): Record<string, unknown> {
    return {
      model: profile.model,
      messages,
      max_tokens: profile.maxTokens,
      temperature: profile.temperature,
      stream: true,
    };
  }

  toEmbedBody(text: string, profile: ProviderProfile): Record<string, unknown> {
    return { model: profile.model, input: text };
  }

  normalizeChatResponse(response: ChatResponse, profile: ProviderProfile): ChatResponse {
    return {
      ...response,
      id: response.id || newResponseId(profile.provider),
      model: response.model || profile.model,
    };
  }

  parseSseChunk(dataLine: string): string {
    if (dataLine === "[DONE]") return "";
    const chunk = JSON.parse(dataLine) as OAIChunk;
    return chunk.choices[0]?.delta?.content ?? "";
  }
}
