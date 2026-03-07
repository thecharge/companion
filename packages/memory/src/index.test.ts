import { describe, expect, test } from "bun:test";
import { SlidingWindow, ContextBuilder } from "./index";
import type { ChatMessage } from "@companion/llm";

describe("SlidingWindow", () => {
  test("splits text into chunks", () => {
    const sw     = new SlidingWindow(100, 20);
    const text   = "a".repeat(250);
    const chunks = sw.splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.pageNum).toBe(0);
    for (const c of chunks) expect(c.totalPages).toBe(chunks.length);
  });

  test("empty text returns empty array", () => {
    const sw = new SlidingWindow(100, 20);
    expect(sw.splitIntoChunks("")).toEqual([]);
  });

  test("prefers newline boundary", () => {
    const sw   = new SlidingWindow(50, 10);
    const text = "line one\n".repeat(20);
    const chunks = sw.splitIntoChunks(text);
    // Each chunk should end at a newline, not mid-word
    for (const c of chunks.slice(0, -1)) {
      expect(c.content.endsWith("\n")).toBe(true);
    }
  });
});

describe("ContextBuilder", () => {
  test("builds messages with system prompt", () => {
    const cb   = new ContextBuilder(40, 8000);
    const msgs = cb.build({
      systemPrompt: "You are helpful.",
      history:      [{ role: "user", content: "hello" }],
    });
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("You are helpful.");
    expect(msgs[1]!.role).toBe("user");
  });

  test("fuses recall into system prompt (single system block)", () => {
    const cb   = new ContextBuilder(40, 8000);
    const msgs = cb.build({
      systemPrompt: "Base prompt.",
      history:      [],
      recall:       ["memory 1", "memory 2"],
    });
    const systemBlocks = msgs.filter((m) => m.role === "system");
    expect(systemBlocks.length).toBe(1);
    expect(systemBlocks[0]!.content).toContain("memory 1");
  });

  test("pair-aware trim never leaves orphaned tool messages", () => {
    const cb = new ContextBuilder(4, 99999); // small message limit
    const history: ChatMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", content: "result", tool_call_id: "c1", name: "f" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const msgs = cb.build({ systemPrompt: "sys", history });
    // No orphaned tool messages — every tool message must be preceded by assistant with tool_calls
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]!.role === "tool") {
        const prev = msgs[i - 1];
        expect(prev?.role).toBe("assistant");
        expect(prev?.tool_calls?.length).toBeGreaterThan(0);
      }
    }
  });

  test("countTokens includes tool_calls JSON", () => {
    const cb = new ContextBuilder();
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "x", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"hello"}' } }],
      },
    ];
    const tokens = cb.countTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
  });
});
