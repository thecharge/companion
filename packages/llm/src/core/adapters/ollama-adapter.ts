import { newResponseId, newToolCallId, parseJsonOrDefault, stripThinking, trimTrailingSlash } from "../helpers";
import { ENDPOINTS } from "../provider-constants";
import type { ChatMessage, ChatParams, ChatResponse } from "../public-types";
import type { ProviderProfile } from "../repositories/provider-profile-repository";

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaAdapter {
  baseUrl(profile: ProviderProfile): string {
    return trimTrailingSlash(profile.baseUrl).replace(/\/v1$/, "");
  }

  chatUrl(profile: ProviderProfile): string {
    return `${this.baseUrl(profile)}${ENDPOINTS.OllamaChat}`;
  }

  embedUrl(profile: ProviderProfile): string {
    return `${this.baseUrl(profile)}${ENDPOINTS.OllamaEmbed}`;
  }

  toMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => {
      if (message.role === "tool") {
        return { role: "tool", content: message.content ?? "", tool_call_id: message.tool_call_id };
      }

      if (message.role === "assistant" && message.tool_calls?.length) {
        return {
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.tool_calls.map((toolCall) => ({
            function: {
              name: toolCall.function.name,
              arguments: parseJsonOrDefault<unknown>(toolCall.function.arguments, toolCall.function.arguments),
            },
          })),
        };
      }

      return { role: message.role, content: message.content ?? "" };
    });
  }

  toChatBody(params: ChatParams, profile: ProviderProfile): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: this.toMessages(params.messages),
      stream: false,
      options: { temperature: profile.temperature, num_predict: profile.maxTokens },
    };

    if (params.tools?.length) {
      body.tools = params.tools;
    }

    if (params.json_mode && !params.tools?.length) {
      body.format = "json";
    }

    return body;
  }

  toStreamBody(messages: ChatMessage[], profile: ProviderProfile): Record<string, unknown> {
    return {
      model: profile.model,
      messages: this.toMessages(messages),
      stream: true,
      options: { temperature: profile.temperature, num_predict: profile.maxTokens },
    };
  }

  toEmbedBody(text: string, profile: ProviderProfile): Record<string, unknown> {
    return { model: profile.model, prompt: text };
  }

  normalizeChatResponse(data: OllamaChatResponse, profile: ProviderProfile): ChatResponse {
    const usage = {
      prompt_tokens: data.prompt_eval_count ?? 0,
      completion_tokens: data.eval_count ?? 0,
      total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };

    if (data.message.tool_calls?.length) {
      return {
        id: newResponseId(profile.provider),
        model: profile.model,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: data.message.content ?? null,
              tool_calls: data.message.tool_calls.map((toolCall, index) => ({
                id: newToolCallId(index),
                type: "function" as const,
                function: {
                  name: toolCall.function.name,
                  arguments:
                    typeof toolCall.function.arguments === "string"
                      ? toolCall.function.arguments
                      : JSON.stringify(toolCall.function.arguments),
                },
              })),
            },
          },
        ],
        usage,
      };
    }

    const { text } = stripThinking(data.message.content);
    return {
      id: newResponseId(profile.provider),
      model: profile.model,
      choices: [{ message: { role: "assistant", content: text || data.message.content }, finish_reason: "stop" }],
      usage,
    };
  }
}
