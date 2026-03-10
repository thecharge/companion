/**
 * @companion/memory
 *
 * - VectorStore abstractions from @companion/db
 * - SlidingWindow: boundary-aware chunking
 * - ContextBuilder: pair-aware trim, merged system prompt, honest token counting
 */

import type { Config } from "@companion/config";
import type { SessionId } from "@companion/core";
import type { VectorStore } from "@companion/db";
import type { ChatMessage } from "@companion/llm";
import { VectorMemoryRepository } from "./vector-memory-repository";

export type { VectorEntry, VectorSearchResult, VectorStore } from "@companion/db";

// ── SlidingWindow ─────────────────────────────────────────────

export interface Chunk {
  content: string;
  pageNum: number;
  totalPages: number;
  charStart: number;
  charEnd: number;
}

export class SlidingWindow {
  constructor(
    private chunkSize = 2000,
    private overlap = 200,
  ) {}

  splitIntoChunks(text: string): Chunk[] {
    if (!text.length) return [];
    const step = this.chunkSize - this.overlap;
    const chunks: Chunk[] = [];
    let pos = 0;

    while (pos < text.length) {
      let end = Math.min(pos + this.chunkSize, text.length);
      if (end < text.length) {
        const lastNewline = text.lastIndexOf("\n", end);
        if (lastNewline > end - 100 && lastNewline > pos) {
          end = lastNewline + 1;
        } else {
          const lastSpace = text.lastIndexOf(" ", end);
          if (lastSpace > end - 50 && lastSpace > pos) {
            end = lastSpace + 1;
          }
        }
      }

      chunks.push({
        content: text.slice(pos, end),
        pageNum: chunks.length,
        totalPages: 0, // filled below
        charStart: pos,
        charEnd: end,
      });

      pos += step;
      if (pos >= text.length) break;
    }

    const total = chunks.length;
    for (const c of chunks) c.totalPages = total;
    return chunks;
  }
}

// ── ContextBuilder ────────────────────────────────────────────

/**
 * Builds the message array for LLM calls:
 *
 * - Fuses recall memories into the system message (no second system block)
 * - Pair-aware trim: never removes an assistant tool_calls without its tool results
 * - Honest token counting: includes tool_calls JSON in estimates
 */
export class ContextBuilder {
  constructor(
    private maxMessages = 40,
    private maxTokens = 8000,
  ) {}

  build(opts: {
    systemPrompt: string;
    history: ChatMessage[];
    recall?: string[];
  }): ChatMessage[] {
    const { systemPrompt, history, recall = [] } = opts;

    let system = systemPrompt;
    if (recall.length) {
      system += `\n\n--- Relevant memories ---\n${recall.map((r, i) => `[${i + 1}] ${r}`).join("\n")}`;
    }

    const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];

    return this.trim(messages);
  }

  /** Honest token estimate — includes tool_calls JSON payload */
  countTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => {
      let chars = (m.content?.length ?? 0) + (m.name?.length ?? 0) + (m.tool_call_id?.length ?? 0);
      if (m.tool_calls?.length) chars += JSON.stringify(m.tool_calls).length;
      return sum + Math.ceil(chars / 4); // 4 chars ≈ 1 token
    }, 0);
  }

  /**
   * Pair-aware trim.
   *
   * When we need to remove messages from the front to stay within limits,
   * we must never leave a "tool" message without its preceding
   * "assistant" message containing tool_calls. That breaks every LLM API.
   */
  trim(messages: ChatMessage[]): ChatMessage[] {
    const result = [...messages];

    // Keep the system message pinned; trim from index 1 onwards
    while (result.length > this.maxMessages + 1 || this.countTokens(result) > this.maxTokens) {
      if (result.length <= 1) break; // only system message left

      // Find the first non-system message and remove it
      const removeIdx = 1;

      // If removing an assistant message that had tool_calls,
      // also remove all immediately following tool messages
      if (result[removeIdx]?.role === "assistant" && result[removeIdx]?.tool_calls?.length) {
        let endIdx = removeIdx + 1;
        while (endIdx < result.length && result[endIdx]?.role === "tool") {
          endIdx++;
        }
        result.splice(removeIdx, endIdx - removeIdx);
      } else {
        result.splice(removeIdx, 1);
      }

      // Remove any dangling tool messages at the front (no preceding assistant)
      while (result[1]?.role === "tool") {
        result.splice(1, 1);
      }
    }

    return result;
  }
}

// ── Memory service ────────────────────────────────────────────

export class MemoryService {
  private context: ContextBuilder;
  private window: SlidingWindow;
  private repository: VectorMemoryRepository;

  constructor(
    private vectors: VectorStore,
    private cfg: Config,
  ) {
    this.context = new ContextBuilder(cfg.memory.context_window.max_messages, cfg.memory.context_window.max_tokens);
    this.window = new SlidingWindow(cfg.memory.sliding_window.chunk_size);
    this.repository = new VectorMemoryRepository(vectors, cfg);
  }

  async recall(sessionId: SessionId, queryEmbedding: number[]): Promise<string[]> {
    return this.repository.recallByEmbedding(sessionId, queryEmbedding);
  }

  async store(
    sessionId: SessionId,
    id: string,
    content: string,
    embedding: number[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.storeEmbedding(sessionId, id, content, embedding, metadata);
  }

  buildContext(opts: {
    systemPrompt: string;
    history: ChatMessage[];
    recall?: string[];
  }): ChatMessage[] {
    return this.context.build(opts);
  }

  chunkText(text: string): Chunk[] {
    return this.window.splitIntoChunks(text);
  }
}
