import { Database } from "bun:sqlite";
import type { Config } from "@companion/config";

export interface VectorEntry {
  id: string;
  session_id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  upsert(entry: VectorEntry): Promise<void>;
  search(sessionId: string, query: number[], topK: number, minScore: number): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export class SqliteVectorStore implements VectorStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init(): void {
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
    const embBytes = new Uint8Array(new Float32Array(entry.embedding).buffer);
    this.db
      .prepare(`
      INSERT INTO vectors (id, session_id, content, embedding, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content    = excluded.content,
        embedding  = excluded.embedding,
        metadata   = excluded.metadata
    `)
      .run(entry.id, entry.session_id, entry.content, embBytes, entry.metadata ? JSON.stringify(entry.metadata) : null);
  }

  async search(sessionId: string, query: number[], topK: number, minScore: number): Promise<VectorSearchResult[]> {
    const rows = this.db
      .prepare("SELECT id, content, embedding, metadata FROM vectors WHERE session_id = ?")
      .all(sessionId) as Array<{
      id: string;
      content: string;
      embedding: ArrayBuffer | Uint8Array;
      metadata: string | null;
    }>;

    return rows
      .map((row) => {
        const bytes = row.embedding instanceof Uint8Array ? row.embedding : new Uint8Array(row.embedding);
        const emb = Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
        const score = cosine(query, emb);
        return {
          id: row.id,
          content: row.content,
          score,
          metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
        };
      })
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

export class PostgresVectorStore implements VectorStore {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async sql() {
    const module = await import("postgres");
    return module.default(this.url, { max: 1, idle_timeout: 5 });
  }

  async upsert(entry: VectorEntry): Promise<void> {
    const sql = await this.sql();
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS vectors (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding JSONB NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        INSERT INTO vectors (id, session_id, content, embedding, metadata)
        VALUES (${entry.id}, ${entry.session_id}, ${entry.content}, ${JSON.stringify(entry.embedding)}::jsonb, ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          embedding = EXCLUDED.embedding,
          metadata = EXCLUDED.metadata
      `;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async search(sessionId: string, query: number[], topK: number, minScore: number): Promise<VectorSearchResult[]> {
    const sql = await this.sql();
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS vectors (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding JSONB NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      const rows = await sql<
        {
          id: string;
          content: string;
          embedding: number[];
          metadata: Record<string, unknown> | null;
        }[]
      >`
        SELECT id, content, embedding, metadata
        FROM vectors
        WHERE session_id = ${sessionId}
      `;

      return rows
        .map((row) => ({
          id: row.id,
          content: row.content,
          score: cosine(query, Array.isArray(row.embedding) ? row.embedding : []),
          metadata: row.metadata ?? undefined,
        }))
        .filter((result) => result.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async delete(id: string): Promise<void> {
    const sql = await this.sql();
    try {
      await sql`DELETE FROM vectors WHERE id = ${id}`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sql = await this.sql();
    try {
      await sql`DELETE FROM vectors WHERE session_id = ${sessionId}`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }
}

export function createVectorStore(cfg: Config): VectorStore {
  if (cfg.db.driver === "postgres") {
    const url = cfg.db.postgres?.url;
    if (!url) {
      throw new Error("db.postgres.url is required when db.driver=postgres");
    }
    return new PostgresVectorStore(url);
  }

  const sqlitePath = cfg.db.sqlite.path.replace(/\.db$/u, "-vec.db");
  return new SqliteVectorStore(sqlitePath);
}
