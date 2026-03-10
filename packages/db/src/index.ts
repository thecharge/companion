/**
 * @companion/db
 *
 * SQLite (via bun:sqlite) and Postgres (via postgres.js) drivers.
 * - OCC: version column, ConcurrencyError on stale writes
 * - FTS5: surgical trigger fires only on title/summary changes
 * - All schema migrations are idempotent (IF NOT EXISTS / IF NOT EXIST)
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Config } from "@companion/config";
import {
  type Message,
  type MessageId,
  type Session,
  type SessionId,
  type SessionMode,
  type SessionStatus,
  asMessage,
  asSession,
  newId,
} from "@companion/core";
import { SQLITE_CORE_SCHEMA, applyPostgresCoreSchema } from "./core-schema";
import { runPostgresMigration, runSqliteMigration } from "./migrations";
export {
  AuditCategory,
  type AuditEventRecord,
  AuditLogRepository,
  AuditStatus,
} from "./audit-log-repository";
export {
  type VectorEntry,
  type VectorSearchResult,
  type VectorStore,
  PostgresVectorStore,
  SqliteVectorStore,
  createVectorStore,
} from "./vector-store";

// ── Errors ────────────────────────────────────────────────────

export class ConcurrencyError extends Error {
  constructor(sessionId: string) {
    super(`Concurrency conflict on session ${sessionId} — stale version`);
    this.name = "ConcurrencyError";
  }
}

// ── SQLite implementation ─────────────────────────────────────

// ── Row mappers ───────────────────────────────────────────────

function rowToSession(r: Record<string, unknown>): Session {
  const summaryValue = r["summary"];
  return {
    id: asSession(r["id"] as string),
    title: r["title"] as string,
    status: r["status"] as SessionStatus,
    mode: r["mode"] as SessionMode,
    blackboard: r["blackboard"] as string,
    summary: typeof summaryValue === "string" ? summaryValue : undefined,
    message_count: r["message_count"] as number,
    version: r["version"] as number,
    created_at: new Date(r["created_at"] as string),
    updated_at: new Date(r["updated_at"] as string),
  };
}

function rowToMessage(r: Record<string, unknown>): Message {
  const toolCallsValue = r["tool_calls"];
  const parsedToolCalls =
    typeof toolCallsValue === "string"
      ? JSON.parse(toolCallsValue)
      : Array.isArray(toolCallsValue)
        ? toolCallsValue
        : undefined;

  return {
    id: asMessage(r["id"] as string),
    session_id: asSession(r["session_id"] as string),
    role: r["role"] as Message["role"],
    content: r["content"] as string,
    tool_calls: parsedToolCalls,
    tool_call_id: r["tool_call_id"] as string | undefined,
    name: r["name"] as string | undefined,
    tokens: r["tokens"] as number | undefined,
    created_at: new Date(r["created_at"] as string),
  };
}

// ── SessionStore ──────────────────────────────────────────────

export interface SessionStore {
  create(id: SessionId, title: string, goal: string, mode: SessionMode): Promise<Session>;
  get(id: SessionId): Promise<Session | null>;
  list(opts?: { status?: SessionStatus; limit?: number; offset?: number }): Promise<Session[]>;
  update(
    id: SessionId,
    patch: Partial<Pick<Session, "title" | "status" | "mode" | "blackboard" | "summary">> & {
      expected_version?: number;
    },
  ): Promise<void>;
  delete(id: SessionId): Promise<void>;
  search(query: string, limit?: number): Promise<Session[]>;
  incrementMessageCount(id: SessionId): Promise<void>;
}

// ── MessageStore ──────────────────────────────────────────────

export interface MessageStore {
  add(msg: Omit<Message, "created_at">): Promise<Message>;
  list(sessionId: SessionId, opts?: { limit?: number; offset?: number }): Promise<Message[]>;
  get(id: MessageId): Promise<Message | null>;
}

// ── Database interface ────────────────────────────────────────

export interface DB {
  sessions: SessionStore;
  messages: MessageStore;
  close(): void;
}

// ── SQLiteDB ──────────────────────────────────────────────────

class SqliteSessionStore implements SessionStore {
  constructor(private db: Database) {}

  async create(id: SessionId, title: string, _goal: string, mode: SessionMode): Promise<Session> {
    this.db
      .prepare(`
      INSERT INTO sessions (id, title, mode) VALUES (?, ?, ?)
    `)
      .run(id, title, mode);
    const created = await this.get(id);
    if (!created) throw new Error(`Failed to create session ${id}`);
    return created;
  }

  async get(id: SessionId): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? rowToSession(row) : null;
  }

  async list(opts: { status?: SessionStatus; limit?: number; offset?: number } = {}): Promise<Session[]> {
    const { status, limit = 50, offset = 0 } = opts;
    let sql = "SELECT * FROM sessions";
    const params: SQLQueryBindings[] = [];
    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  async update(
    id: SessionId,
    patch: Partial<Pick<Session, "title" | "status" | "mode" | "blackboard" | "summary">> & {
      expected_version?: number;
    },
  ): Promise<void> {
    const sets: string[] = ["updated_at = datetime('now','utc')"];
    const vals: SQLQueryBindings[] = [];

    if (patch.title !== undefined) {
      sets.push("title = ?");
      vals.push(patch.title);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.mode !== undefined) {
      sets.push("mode = ?");
      vals.push(patch.mode);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      vals.push(patch.summary);
    }
    if (patch.blackboard !== undefined) {
      sets.push("blackboard = ?");
      sets.push("version = version + 1");
      vals.push(patch.blackboard);
    }

    let sql = `UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`;
    vals.push(id);

    if (patch.expected_version !== undefined) {
      sql += " AND version = ?";
      vals.push(patch.expected_version);
    }

    const result = this.db.prepare(sql).run(...vals);

    if (patch.expected_version !== undefined && result.changes === 0) {
      // Check if row exists at all or if it was a version mismatch
      const exists = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
      if (exists) throw new ConcurrencyError(id);
    }
  }

  async delete(id: SessionId): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async search(query: string, limit = 10): Promise<Session[]> {
    const rows = this.db
      .prepare(`
      SELECT s.* FROM sessions s
      JOIN sessions_fts fts ON s.id = fts.id
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
      .all(query, limit) as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  async incrementMessageCount(id: SessionId): Promise<void> {
    this.db
      .prepare("UPDATE sessions SET message_count = message_count + 1, updated_at = datetime('now','utc') WHERE id = ?")
      .run(id);
  }
}

class SqliteMessageStore implements MessageStore {
  constructor(private db: Database) {}

  async add(msg: Omit<Message, "created_at">): Promise<Message> {
    this.db
      .prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, name, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        msg.id,
        msg.session_id,
        msg.role,
        msg.content,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_call_id ?? null,
        msg.name ?? null,
        msg.tokens ?? null,
      );
    const created = await this.get(msg.id);
    if (!created) throw new Error(`Failed to create message ${msg.id}`);
    return created;
  }

  async list(sessionId: SessionId, opts: { limit?: number; offset?: number } = {}): Promise<Message[]> {
    const { limit = 100, offset = 0 } = opts;
    const rows = this.db
      .prepare(`
      SELECT * FROM messages WHERE session_id = ?
      ORDER BY created_at ASC LIMIT ? OFFSET ?
    `)
      .all(sessionId, limit, offset) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  async get(id: MessageId): Promise<Message | null> {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? rowToMessage(row) : null;
  }
}

export class SqliteDB implements DB {
  private raw: Database;
  sessions: SessionStore;
  messages: MessageStore;

  constructor(path: string) {
    this.raw = new Database(path, { create: true });
    runSqliteMigration(
      this.raw,
      "core-sqlite-v1",
      () => {
        this.raw.exec(SQLITE_CORE_SCHEMA);
      },
      { transactional: false },
    );
    this.sessions = new SqliteSessionStore(this.raw);
    this.messages = new SqliteMessageStore(this.raw);
  }

  close(): void {
    this.raw.close();
  }
}

class PostgresSessionStore implements SessionStore {
  constructor(private readonly cfg: Config) {}

  private async sql() {
    const url = this.cfg.db.postgres?.url;
    if (!url) {
      throw new Error("db.postgres.url is required when db.driver=postgres");
    }
    const module = await import("postgres");
    return module.default(url, { max: 1, idle_timeout: 5 });
  }

  async create(id: SessionId, title: string, _goal: string, mode: SessionMode): Promise<Session> {
    const sql = await this.sql();
    try {
      await sql`
        INSERT INTO sessions (id, title, mode)
        VALUES (${id}, ${title}, ${mode})
      `;
      const created = await this.get(id);
      if (!created) throw new Error(`Failed to create session ${id}`);
      return created;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async get(id: SessionId): Promise<Session | null> {
    const sql = await this.sql();
    try {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT * FROM sessions WHERE id = ${id}
      `;
      const row = rows[0];
      return row ? rowToSession(row) : null;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async list(opts: { status?: SessionStatus; limit?: number; offset?: number } = {}): Promise<Session[]> {
    const sql = await this.sql();
    const { status, limit = 50, offset = 0 } = opts;
    try {
      const rows = status
        ? await sql<Record<string, unknown>[]>`
            SELECT * FROM sessions
            WHERE status = ${status}
            ORDER BY updated_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : await sql<Record<string, unknown>[]>`
            SELECT * FROM sessions
            ORDER BY updated_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
      return rows.map(rowToSession);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async update(
    id: SessionId,
    patch: Partial<Pick<Session, "title" | "status" | "mode" | "blackboard" | "summary">> & {
      expected_version?: number;
    },
  ): Promise<void> {
    const sql = await this.sql();
    try {
      const sets: string[] = ["updated_at = NOW()"];
      const values: unknown[] = [];

      if (patch.title !== undefined) {
        sets.push(`title = $${values.length + 1}`);
        values.push(patch.title);
      }
      if (patch.status !== undefined) {
        sets.push(`status = $${values.length + 1}`);
        values.push(patch.status);
      }
      if (patch.mode !== undefined) {
        sets.push(`mode = $${values.length + 1}`);
        values.push(patch.mode);
      }
      if (patch.summary !== undefined) {
        sets.push(`summary = $${values.length + 1}`);
        values.push(patch.summary);
      }
      if (patch.blackboard !== undefined) {
        sets.push(`blackboard = $${values.length + 1}`);
        sets.push("version = version + 1");
        values.push(patch.blackboard);
      }

      const idParam = values.length + 1;
      let sqlText = `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${idParam}`;
      values.push(id);

      if (patch.expected_version !== undefined) {
        const versionParam = values.length + 1;
        sqlText += ` AND version = $${versionParam}`;
        values.push(patch.expected_version);
      }

      const result = await sql.unsafe(sqlText, values as never[]);
      if (patch.expected_version !== undefined && result.count === 0) {
        const exists = await sql<Record<string, unknown>[]>`SELECT 1 FROM sessions WHERE id = ${id}`;
        if (exists.length > 0) throw new ConcurrencyError(id);
      }
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async delete(id: SessionId): Promise<void> {
    const sql = await this.sql();
    try {
      await sql`DELETE FROM sessions WHERE id = ${id}`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async search(query: string, limit = 10): Promise<Session[]> {
    const sql = await this.sql();
    try {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT *
        FROM sessions
        WHERE title ILIKE ${`%${query}%`} OR COALESCE(summary, '') ILIKE ${`%${query}%`}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      return rows.map(rowToSession);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async incrementMessageCount(id: SessionId): Promise<void> {
    const sql = await this.sql();
    try {
      await sql`
        UPDATE sessions
        SET message_count = message_count + 1,
            updated_at = NOW()
        WHERE id = ${id}
      `;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }
}

class PostgresMessageStore implements MessageStore {
  constructor(private readonly cfg: Config) {}

  private async sql() {
    const url = this.cfg.db.postgres?.url;
    if (!url) {
      throw new Error("db.postgres.url is required when db.driver=postgres");
    }
    const module = await import("postgres");
    return module.default(url, { max: 1, idle_timeout: 5 });
  }

  async add(msg: Omit<Message, "created_at">): Promise<Message> {
    const sql = await this.sql();
    try {
      await sql`
        INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, name, tokens)
        VALUES (
          ${msg.id},
          ${msg.session_id},
          ${msg.role},
          ${msg.content},
          ${msg.tool_calls ? JSON.stringify(msg.tool_calls) : null}::jsonb,
          ${msg.tool_call_id ?? null},
          ${msg.name ?? null},
          ${msg.tokens ?? null}
        )
      `;
      const created = await this.get(msg.id);
      if (!created) throw new Error(`Failed to create message ${msg.id}`);
      return created;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async list(sessionId: SessionId, opts: { limit?: number; offset?: number } = {}): Promise<Message[]> {
    const { limit = 100, offset = 0 } = opts;
    const sql = await this.sql();
    try {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT * FROM messages
        WHERE session_id = ${sessionId}
        ORDER BY created_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
      return rows.map(rowToMessage);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  async get(id: MessageId): Promise<Message | null> {
    const sql = await this.sql();
    try {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT * FROM messages WHERE id = ${id}
      `;
      const row = rows[0];
      return row ? rowToMessage(row) : null;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }
}

export class PostgresDB implements DB {
  sessions: SessionStore;
  messages: MessageStore;

  constructor(private readonly cfg: Config) {
    this.sessions = new PostgresSessionStore(cfg);
    this.messages = new PostgresMessageStore(cfg);
  }

  async initialize(): Promise<void> {
    const url = this.cfg.db.postgres?.url;
    if (!url) {
      throw new Error("db.postgres.url is required when db.driver=postgres");
    }

    await runPostgresMigration(url, "core-postgres-v1", async (sql) => {
      await applyPostgresCoreSchema(sql);
    });
  }

  close(): void {
    // Driver uses short-lived connections per method call.
  }
}

type DriverFactory = (cfg: Config) => Promise<DB>;

const SQLITE_FACTORY: DriverFactory = async (cfg) => {
  const dir = cfg.db.sqlite.path.split("/").slice(0, -1).join("/");
  if (dir) await Bun.write(`${dir}/.keep`, "");
  return new SqliteDB(cfg.db.sqlite.path);
};

const POSTGRES_FACTORY: DriverFactory = async (cfg) => {
  const db = new PostgresDB(cfg);
  await db.initialize();
  return db;
};

const DRIVER_FACTORIES: Partial<Record<Config["db"]["driver"], DriverFactory>> = {
  sqlite: SQLITE_FACTORY,
  postgres: POSTGRES_FACTORY,
};

// ── Factory ───────────────────────────────────────────────────

export async function createDB(cfg: Config): Promise<DB> {
  const factory = DRIVER_FACTORIES[cfg.db.driver];
  if (!factory) {
    throw new Error(`Unsupported db driver: ${cfg.db.driver}`);
  }
  return factory(cfg);
}

// Convenience — used in tests
export function createMemoryDB(): DB {
  return new SqliteDB(":memory:");
}

// Re-export core types needed by callers
export type { Session, Message, SessionId, MessageId, SessionMode, SessionStatus };
export { asSession, asMessage, newId };
