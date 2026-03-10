import { newResponseId, newToolCallId, parseJsonOrDefault, trimTrailingSlash } from "../helpers";
import { ENDPOINTS } from "../provider-constants";
import type { ChatMessage, ChatParams, ChatResponse, OAITool } from "../public-types";
import type { ProviderProfile } from "../repositories/provider-profile-repository";

export class GeminiAdapter {
  endpoint(profile: ProviderProfile, stream = false): string {
    const base = trimTrailingSlash(profile.baseUrl);
    const key = profile.apiKey ? `?key=${profile.apiKey}` : "";
    const action = stream ? ENDPOINTS.GeminiStream : ENDPOINTS.GeminiGenerate;
    return `${base}/models/${profile.model}:${action}${key}`;
  }

  embedEndpoint(profile: ProviderProfile): string {
    const base = trimTrailingSlash(profile.baseUrl);
    const key = profile.apiKey ? `?key=${profile.apiKey}` : "";
    return `${base}/models/${profile.model}:${ENDPOINTS.GeminiEmbed}${key}`;
  }

  toContents(messages: ChatMessage[]): Array<{ role: string; parts: unknown[] }> {
    const contents: Array<{ role: string; parts: unknown[] }> = [];

    for (const message of messages) {
      if (message.role === "system") {
        contents.push({ role: "user", parts: [{ text: `[System]: ${message.content ?? ""}` }] });
        contents.push({ role: "model", parts: [{ text: "Understood." }] });
        continue;
      }

      if (message.role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: message.name ?? message.tool_call_id ?? "unknown_tool",
                response: parseJsonOrDefault<Record<string, unknown>>(message.content ?? "{}", {
                  result: message.content ?? "",
                }),
              },
            },
          ],
        });
        continue;
      }

      if (message.role === "assistant" && message.tool_calls?.length) {
        contents.push({
          role: "model",
          parts: message.tool_calls.map((toolCall) => ({
            functionCall: {
              name: toolCall.function.name,
              args: parseJsonOrDefault<Record<string, unknown>>(toolCall.function.arguments, {}),
            },
          })),
        });
        continue;
      }

      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content ?? "" }],
      });
    }

    return contents;
  }

  toTools(tools: OAITool[]): Array<{ functionDeclarations: unknown[] }> {
    return [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ];
  }

  toChatBody(params: ChatParams, profile: ProviderProfile): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: this.toContents(params.messages),
      generationConfig: { temperature: profile.temperature, maxOutputTokens: profile.maxTokens },
    };

    if (params.tools?.length) {
      body.tools = this.toTools(params.tools);
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    return body;
  }

  toStreamBody(messages: ChatMessage[], profile: ProviderProfile): Record<string, unknown> {
    return {
      contents: this.toContents(messages),
      generationConfig: { temperature: profile.temperature, maxOutputTokens: profile.maxTokens },
    };
  }

  toEmbedBody(text: string, profile: ProviderProfile): Record<string, unknown> {
    return { model: profile.model, content: { parts: [{ text }] } };
  }

  normalizeChatResponse(data: Record<string, unknown>, profile: ProviderProfile): ChatResponse {
    const candidates = (data.candidates as Array<Record<string, unknown>> | undefined) ?? [];
    const parts =
      ((candidates[0]?.content as Record<string, unknown> | undefined)?.parts as
        | Array<Record<string, unknown>>
        | undefined) ?? [];

    const usage = data.usageMetadata as { promptTokenCount: number; candidatesTokenCount: number } | undefined;
    const usageStats = usage
      ? {
          prompt_tokens: usage.promptTokenCount,
          completion_tokens: usage.candidatesTokenCount,
          total_tokens: usage.promptTokenCount + usage.candidatesTokenCount,
        }
      : undefined;

    const functionCalls = parts.filter((part) => Boolean(part.functionCall));
    if (functionCalls.length) {
      return {
        id: newResponseId(profile.provider),
        model: profile.model,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: functionCalls.map((part, index) => ({
                id: newToolCallId(index),
                type: "function" as const,
                function: {
                  name: String((part.functionCall as Record<string, unknown>).name),
                  arguments: JSON.stringify((part.functionCall as Record<string, unknown>).args ?? {}),
                },
              })),
            },
          },
        ],
        usage: usageStats,
      };
    }

    const text = parts
      .filter((part) => Boolean(part.text))
      .map((part) => String(part.text))
      .join("");

    return {
      id: newResponseId(profile.provider),
      model: profile.model,
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: usageStats,
    };
  }
}
