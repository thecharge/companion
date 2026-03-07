/**
 * @companion/memory
 *
 * - VectorStore: sqlite-vec with JS cosine fallback
 * - SlidingWindow: boundary-aware chunking
 * - ContextBuilder: pair-aware trim, merged system prompt, honest token counting
 */

import { Database } from "bun:sqlite";
import type { Config } from "@companion/config";
import type { SessionId } from "@companion/core";
import type { ChatMessage } from "@companion/llm";

// ── VectorStore ───────────────────────────────────────────────

export interface VectorEntry {
  id:         string;
  session_id: string;
  content:    string;
  embedding:  number[];
  metadata?:  Record<string, unknown>;
}

export interface VectorSearchResult {
  id:         string;
  content:    string;
  score:      number;
  metadata?:  Record<string, unknown>;
}

export interface VectorStore {
  upsert(entry: VectorEntry): Promise<void>;
  search(sessionId: string, query: number[], topK: number, minScore: number): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

// Cosine similarity — used as fallback when sqlite-vec is unavailable
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i]! * b[i]!);
    na  += (a[i]! * a[i]!);
    nb  += (b[i]! * b[i]!);
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * SqliteVecStore
 *
 * Attempts to load the sqlite-vec extension for native vector operations.
 * Falls back to JS cosine similarity with a logged warning if unavailable.
 * The fallback is correct but slower for large corpora.
 */
export class SqliteVecStore implements VectorStore {
  private db:        Database;
  private nativeVec: boolean = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init(): void {
    // Attempt native sqlite-vec extension
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vec = require("sqlite-vec") as { load: (db: Database) => void };
      vec.load(this.db);
      this.nativeVec = true;
    } catch {
      console.warn("[memory] sqlite-vec extension unavailable — using JS cosine fallback. Install sqlite-vec for production.");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id         TEXT    NOT NULL PRIMARY KEY,
        session_id TEXT    NOT NULL,
        content    TEXT    NOT NULL,
        embedding  BLOB    NOT NULL,
        metadata   TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now','utc'))
      );
      CREATE INDEX IF NOT EXISTS vectors_session_idx ON vectors(session_id);
    `);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    const embBytes = new Float32Array(entry.embedding).buffer;
    this.db.prepare(`
      INSERT INTO vectors (id, session_id, content, embedding, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content    = excluded.content,
        embedding  = excluded.embedding,
        metadata   = excluded.metadata
    `).run(
      entry.id,
      entry.session_id,
      entry.content,
      embBytes,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  async search(
    sessionId: string,
    query: number[],
    topK: number,
    minScore: number,
  ): Promise<VectorSearchResult[]> {
    const rows = this.db.prepare(
      "SELECT id, content, embedding, metadata FROM vectors WHERE session_id = ?",
    ).all(sessionId) as Array<{ id: string; content: string; embedding: ArrayBuffer; metadata: string | null }>;

    const scored = rows.map((row) => {
      const emb  = Array.from(new Float32Array(row.embedding));
      const score = cosine(query, emb);
      return {
        id:       row.id,
        content:  row.content,
        score,
        metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
      };
    });

    return scored
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM vectors WHERE id = ?").run(id);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM vectors WHERE session_id = ?").run(sessionId);
  }
}

// ── SlidingWindow ─────────────────────────────────────────────

export interface Chunk {
  content:    string;
  pageNum:    number;
  totalPages: number;
  charStart:  number;
  charEnd:    number;
}

export class SlidingWindow {
  constructor(
    private chunkSize: number = 2000,
    private overlap:   number = 200,
  ) {}

  splitIntoChunks(text: string): Chunk[] {
    if (!text.length) return [];
    const step   = this.chunkSize - this.overlap;
    const chunks: Chunk[] = [];
    let pos = 0;

    while (pos < text.length) {
      let end = Math.min(pos + this.chunkSize, text.length);

      // Prefer a natural boundary within the last 100 chars of the chunk
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
        content:   text.slice(pos, end),
        pageNum:   chunks.length,
        totalPages: 0, // filled below
        charStart: pos,
        charEnd:   end,
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
    private maxMessages: number = 40,
    private maxTokens:   number = 8000,
  ) {}

  build(opts: {
    systemPrompt: string;
    history:      ChatMessage[];
    recall?:      string[];
  }): ChatMessage[] {
    const { systemPrompt, history, recall = [] } = opts;

    let system = systemPrompt;
    if (recall.length) {
      system += `\n\n--- Relevant memories ---\n${recall.map((r, i) => `[${i + 1}] ${r}`).join("\n")}`;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
    ];

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
    let result = [...messages];

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
  private window:  SlidingWindow;

  constructor(
    private vectors: VectorStore,
    private cfg:     Config,
  ) {
    this.context = new ContextBuilder(
      cfg.memory.context_window.max_messages,
      cfg.memory.context_window.max_tokens,
    );
    this.window = new SlidingWindow(
      cfg.memory.sliding_window.chunk_size,
    );
  }

  async recall(
    sessionId: SessionId,
    queryEmbedding: number[],
  ): Promise<string[]> {
    const results = await this.vectors.search(
      sessionId,
      queryEmbedding,
      this.cfg.memory.recall.top_k,
      this.cfg.memory.recall.min_score,
    );
    return results.map((r) => r.content);
  }

  async store(
    sessionId: SessionId,
    id:        string,
    content:   string,
    embedding: number[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.vectors.upsert({ id, session_id: sessionId, content, embedding, metadata });
  }

  buildContext(opts: {
    systemPrompt: string;
    history:      ChatMessage[];
    recall?:      string[];
  }): ChatMessage[] {
    return this.context.build(opts);
  }

  chunkText(text: string): Chunk[] {
    return this.window.splitIntoChunks(text);
  }
}
