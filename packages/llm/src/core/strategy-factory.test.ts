import { describe, expect, test } from "bun:test";
import { createLLMClient } from "../index";

describe("provider strategy routing", () => {
  test("uses openai-compatible strategy for openai provider", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          id: "resp-openai",
          model: "gpt-4.1-mini",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const client = createLLMClient({
        provider: "openai",
        model: "gpt-4.1-mini",
        api_key: "test",
        max_tokens: 128,
        temperature: 0,
      });

      const response = await client.chat({ messages: [{ role: "user", content: "hello" }] });
      expect(response.choices[0]?.message.content).toBe("ok");
      expect(calls[0]?.endsWith("/chat/completions")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses ollama strategy for ollama provider", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          message: { role: "assistant", content: "ok" },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const client = createLLMClient({
        provider: "ollama",
        model: "qwen3:4b",
        base_url: "http://localhost:11434",
        max_tokens: 128,
        temperature: 0,
      });

      const response = await client.chat({ messages: [{ role: "user", content: "hello" }] });
      expect(response.choices[0]?.message.content).toBe("ok");
      expect(calls[0]?.endsWith("/api/chat")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses gemini strategy for gemini provider", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const client = createLLMClient({
        provider: "gemini",
        model: "gemini-2.0-flash",
        api_key: "test",
        max_tokens: 128,
        temperature: 0,
      });

      const response = await client.chat({ messages: [{ role: "user", content: "hello" }] });
      expect(response.choices[0]?.message.content).toBe("ok");
      expect(calls[0]?.includes(":generateContent")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
