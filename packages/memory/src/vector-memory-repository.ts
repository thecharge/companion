import type { Config } from "@companion/config";
import type { SessionId } from "@companion/core";
import type { VectorStore } from "./index";

export class VectorMemoryRepository {
  constructor(
    private readonly vectorStore: VectorStore,
    private readonly cfg: Config,
  ) {}

  async recallByEmbedding(sessionId: SessionId, embedding: number[]): Promise<string[]> {
    const rows = await this.vectorStore.search(
      sessionId,
      embedding,
      this.cfg.memory.recall.top_k,
      this.cfg.memory.recall.min_score,
    );
    return rows.map((row) => row.content);
  }

  async storeEmbedding(
    sessionId: SessionId,
    id: string,
    content: string,
    embedding: number[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.vectorStore.upsert({
      id,
      session_id: sessionId,
      content,
      embedding,
      metadata,
    });
  }
}
