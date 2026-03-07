/**
 * @companion/db
 *
 * SQLite (via bun:sqlite) and Postgres (via postgres.js) drivers.
 * - OCC: version column, ConcurrencyError on stale writes
 * - FTS5: surgical trigger fires only on title/summary changes
 * - All schema migrations are idempotent (IF NOT EXISTS / IF NOT EXIST)
 */

import { Database } from "bun:sqlite";
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

// ── Errors ────────────────────────────────────────────────────

export class ConcurrencyError extends Error {
  constructor(sessionId: string) {
    super(`Concurrency conflict on session ${sessionId} — stale version`);
    this.name = "ConcurrencyError";
  }
}

// ── SQLite implementation ─────────────────────────────────────

const SQLITE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    NOT NULL PRIMARY KEY,
  title         TEXT    NOT NULL DEFAULT 'New Session',
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','archived','summarised')),
  mode          TEXT    NOT NULL DEFAULT 'local'
                        CHECK(mode IN ('local','balanced','cloud')),
  blackboard    TEXT    NOT NULL DEFAULT '{}',
  summary       TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','utc')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','utc'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT    NOT NULL PRIMARY KEY,
  session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role          TEXT    NOT NULL
                        CHECK(role IN ('user','assistant','system','tool')),
  content       TEXT    NOT NULL DEFAULT '',
  tool_calls    TEXT,
  tool_call_id  TEXT,
  name          TEXT,
  tokens        INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','utc'))
);

CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, created_at);

-- FTS5 for session search
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  id, title, summary,
  content='sessions',
  content_rowid='rowid'
);

-- SURGICAL: trigger fires only when title or summary actually changes.
-- Blackboard updates (every agent tick) must NOT rebuild the FTS index.
CREATE TRIGGER IF NOT EXISTS sessions_fts_update
AFTER UPDATE OF title, summary ON sessions
WHEN new.title != old.title OR (new.summary IS NOT old.summary)
BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, id, title, summary)
  VALUES('delete', old.rowid, old.id, old.title, old.summary);
  INSERT INTO sessions_fts(rowid, id, title, summary)
  VALUES(new.rowid, new.id, new.title, coalesce(new.summary,''));
END;

CREATE TRIGGER IF NOT EXISTS sessions_fts_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO sessions_fts(rowid, id, title, summary)
  VALUES(new.rowid, new.id, new.title, coalesce(new.summary,''));
END;

CREATE TRIGGER IF NOT EXISTS sessions_fts_delete
AFTER DELETE ON sessions
BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, id, title, summary)
  VALUES('delete', old.rowid, old.id, old.title, old.summary);
END;
`;

// ── Row mappers ───────────────────────────────────────────────

function rowToSession(r: Record<string, unknown>): Session {
  return {
    id:            asSession(r["id"] as string),
    title:         r["title"]         as string,
    status:        r["status"]        as SessionStatus,
    mode:          r["mode"]          as SessionMode,
    blackboard:    r["blackboard"]    as string,
    summary:       r["summary"]       as string | undefined,
    message_count: r["message_count"] as number,
    version:       r["version"]       as number,
    created_at:    new Date(r["created_at"] as string),
    updated_at:    new Date(r["updated_at"] as string),
  };
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id:           asMessage(r["id"] as string),
    session_id:   asSession(r["session_id"] as string),
    role:         r["role"]         as Message["role"],
    content:      r["content"]      as string,
    tool_calls:   r["tool_calls"]   ? JSON.parse(r["tool_calls"] as string) : undefined,
    tool_call_id: r["tool_call_id"] as string | undefined,
    name:         r["name"]         as string | undefined,
    tokens:       r["tokens"]       as number | undefined,
    created_at:   new Date(r["created_at"] as string),
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
    this.db.prepare(`
      INSERT INTO sessions (id, title, mode) VALUES (?, ?, ?)
    `).run(id, title, mode);
    return (await this.get(id))!;
  }

  async get(id: SessionId): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? rowToSession(row) : null;
  }

  async list(opts: { status?: SessionStatus; limit?: number; offset?: number } = {}): Promise<Session[]> {
    const { status, limit = 50, offset = 0 } = opts;
    let sql = "SELECT * FROM sessions";
    const params: unknown[] = [];
    if (status) { sql += " WHERE status = ?"; params.push(status); }
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
    const vals: unknown[] = [];

    if (patch.title     !== undefined) { sets.push("title = ?");     vals.push(patch.title); }
    if (patch.status    !== undefined) { sets.push("status = ?");    vals.push(patch.status); }
    if (patch.mode      !== undefined) { sets.push("mode = ?");      vals.push(patch.mode); }
    if (patch.summary   !== undefined) { sets.push("summary = ?");   vals.push(patch.summary); }
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
    const rows = this.db.prepare(`
      SELECT s.* FROM sessions s
      JOIN sessions_fts fts ON s.id = fts.id
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  async incrementMessageCount(id: SessionId): Promise<void> {
    this.db.prepare("UPDATE sessions SET message_count = message_count + 1, updated_at = datetime('now','utc') WHERE id = ?").run(id);
  }
}

class SqliteMessageStore implements MessageStore {
  constructor(private db: Database) {}

  async add(msg: Omit<Message, "created_at">): Promise<Message> {
    this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, name, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.session_id,
      msg.role,
      msg.content,
      msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
      msg.tool_call_id ?? null,
      msg.name ?? null,
      msg.tokens ?? null,
    );
    return (await this.get(msg.id))!;
  }

  async list(sessionId: SessionId, opts: { limit?: number; offset?: number } = {}): Promise<Message[]> {
    const { limit = 100, offset = 0 } = opts;
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ?
      ORDER BY created_at ASC LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as Record<string, unknown>[];
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
    this.raw      = new Database(path, { create: true });
    this.raw.exec(SQLITE_SCHEMA);
    this.sessions = new SqliteSessionStore(this.raw);
    this.messages = new SqliteMessageStore(this.raw);
  }

  close(): void {
    this.raw.close();
  }
}

// ── Factory ───────────────────────────────────────────────────

export async function createDB(cfg: Config): Promise<DB> {
  if (cfg.db.driver === "sqlite") {
    const dir = cfg.db.sqlite.path.split("/").slice(0, -1).join("/");
    if (dir) await Bun.write(`${dir}/.keep`, "");
    return new SqliteDB(cfg.db.sqlite.path);
  }
  throw new Error("postgres driver: use createPostgresDB() from @companion/db/postgres");
}

// Convenience — used in tests
export function createMemoryDB(): DB {
  return new SqliteDB(":memory:");
}

// Re-export core types needed by callers
export type { Session, Message, SessionId, MessageId, SessionMode, SessionStatus };
export { asSession, asMessage, newId };
