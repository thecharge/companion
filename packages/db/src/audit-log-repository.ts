import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "@companion/config";
import { runPostgresMigration, runSqliteMigration } from "./migrations";

export const AuditCategory = {
  Http: "http",
  Agent: "agent",
  Tool: "tool",
  Session: "session",
  Error: "error",
} as const;

export type AuditCategory = (typeof AuditCategory)[keyof typeof AuditCategory];

export const AuditStatus = {
  Ok: "ok",
  Error: "error",
} as const;

export type AuditStatus = (typeof AuditStatus)[keyof typeof AuditStatus];

export interface AuditEventRecord {
  event_id?: string;
  timestamp: string;
  category: AuditCategory;
  action: string;
  status: AuditStatus;
  session_id?: string;
  actor_id?: string;
  actor_type?: string;
  source_ip?: string;
  request_id?: string;
  http_method?: string;
  http_path?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}

interface AuditLogRepositoryOptions {
  cfg: Config;
  mirrorPath?: string;
  maxRows?: number;
  rotateBytes?: number;
  rotateFiles?: number;
}

const NEWLINE = "\n";
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ROTATE_FILES = 5;

function getEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export class AuditLogRepository {
  private readonly cfg: Config;
  private readonly mirrorPath?: string;
  private readonly maxRows: number;
  private readonly rotateBytes: number;
  private readonly rotateFiles: number;

  constructor(options: AuditLogRepositoryOptions) {
    this.cfg = options.cfg;
    this.mirrorPath = options.mirrorPath;
    this.maxRows = options.maxRows ?? getEnvInt("AUDIT_LOG_DB_MAX_ROWS", DEFAULT_MAX_ROWS);
    this.rotateBytes = options.rotateBytes ?? getEnvInt("AUDIT_LOG_ROTATE_BYTES", DEFAULT_ROTATE_BYTES);
    this.rotateFiles = options.rotateFiles ?? getEnvInt("AUDIT_LOG_ROTATE_FILES", DEFAULT_ROTATE_FILES);
  }

  async initialize(): Promise<void> {
    if (this.cfg.db.driver === "postgres") {
      await this.initPostgres();
    } else {
      this.initSqlite();
    }

    if (this.mirrorPath) {
      await mkdir(dirname(this.mirrorPath), { recursive: true });
    }
  }

  async record(event: AuditEventRecord): Promise<void> {
    const normalized: AuditEventRecord = {
      ...event,
      event_id: event.event_id ?? randomUUID(),
    };

    if (this.cfg.db.driver === "postgres") {
      await this.insertPostgres(normalized);
      await this.prunePostgres();
    } else {
      this.insertSqlite(normalized);
      this.pruneSqlite();
    }

    if (this.mirrorPath) {
      await this.appendMirror(normalized);
    }
  }

  async listRecent(limit: number): Promise<AuditEventRecord[]> {
    if (this.cfg.db.driver === "postgres") {
      const rows = await this.listPostgres(limit);
      return rows.reverse();
    }

    const rows = this.listSqlite(limit);
    return rows.reverse();
  }

  private sqliteDb() {
    const path = this.cfg.db.sqlite.path;
    const db = new Database(path, { create: true });
    return db;
  }

  private initSqlite(): void {
    const db = this.sqliteDb();
    try {
      runSqliteMigration(db, "audit-sqlite-v1", () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            category TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            session_id TEXT,
            actor_id TEXT,
            actor_type TEXT,
            source_ip TEXT,
            request_id TEXT,
            http_method TEXT,
            http_path TEXT,
            user_agent TEXT,
            metadata TEXT
          );
          CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events(timestamp DESC);
        `);
      });
      this.ensureSqliteColumns(db);
    } finally {
      db.close();
    }
  }

  private ensureSqliteColumns(db: Database): void {
    const existing = new Set(
      (db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>).map((row) => row.name),
    );

    const alterColumn = (name: string, type: string): void => {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE audit_events ADD COLUMN ${name} ${type}`);
      }
    };

    alterColumn("event_id", "TEXT");
    alterColumn("actor_id", "TEXT");
    alterColumn("actor_type", "TEXT");
    alterColumn("source_ip", "TEXT");
    alterColumn("request_id", "TEXT");
    alterColumn("http_method", "TEXT");
    alterColumn("http_path", "TEXT");
    alterColumn("user_agent", "TEXT");
    db.exec("UPDATE audit_events SET event_id = printf('legacy-%d', id) WHERE event_id IS NULL OR event_id = ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS audit_events_event_id_idx ON audit_events(event_id)");
    db.exec("CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events(timestamp DESC)");
  }

  private insertSqlite(event: AuditEventRecord): void {
    const db = this.sqliteDb();
    try {
      this.ensureSqliteColumns(db);
      db.prepare(
        "INSERT INTO audit_events (event_id, timestamp, category, action, status, session_id, actor_id, actor_type, source_ip, request_id, http_method, http_path, user_agent, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        event.event_id ?? randomUUID(),
        event.timestamp,
        event.category,
        event.action,
        event.status,
        event.session_id ?? null,
        event.actor_id ?? null,
        event.actor_type ?? null,
        event.source_ip ?? null,
        event.request_id ?? null,
        event.http_method ?? null,
        event.http_path ?? null,
        event.user_agent ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      );
    } finally {
      db.close();
    }
  }

  private listSqlite(limit: number): AuditEventRecord[] {
    const db = this.sqliteDb();
    try {
      this.ensureSqliteColumns(db);
      const rows = db
        .prepare(
          "SELECT event_id, timestamp, category, action, status, session_id, actor_id, actor_type, source_ip, request_id, http_method, http_path, user_agent, metadata FROM audit_events ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as Array<{
        event_id: string;
        timestamp: string;
        category: AuditCategory;
        action: string;
        status: AuditStatus;
        session_id: string | null;
        actor_id: string | null;
        actor_type: string | null;
        source_ip: string | null;
        request_id: string | null;
        http_method: string | null;
        http_path: string | null;
        user_agent: string | null;
        metadata: string | null;
      }>;

      return rows.map((row) => ({
        event_id: row.event_id,
        timestamp: row.timestamp,
        category: row.category,
        action: row.action,
        status: row.status,
        session_id: row.session_id ?? undefined,
        actor_id: row.actor_id ?? undefined,
        actor_type: row.actor_type ?? undefined,
        source_ip: row.source_ip ?? undefined,
        request_id: row.request_id ?? undefined,
        http_method: row.http_method ?? undefined,
        http_path: row.http_path ?? undefined,
        user_agent: row.user_agent ?? undefined,
        metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
      }));
    } finally {
      db.close();
    }
  }

  private pruneSqlite(): void {
    const db = this.sqliteDb();
    try {
      db.prepare(
        `
        DELETE FROM audit_events
        WHERE id NOT IN (
          SELECT id
          FROM audit_events
          ORDER BY id DESC
          LIMIT ?
        )
        `,
      ).run(this.maxRows);
    } finally {
      db.close();
    }
  }

  private async pgClient() {
    const url = this.cfg.db.postgres?.url;
    if (!url) {
      throw new Error("db.postgres.url is required when db.driver=postgres");
    }
    const module = await import("postgres");
    return module.default(url, { max: 1, idle_timeout: 5 });
  }

  private async initPostgres(): Promise<void> {
    const url = this.cfg.db.postgres?.url;
    if (!url) {
      throw new Error("db.postgres.url is required when db.driver=postgres");
    }

    await runPostgresMigration(url, "audit-postgres-v1", async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS audit_events (
          id BIGSERIAL PRIMARY KEY,
          event_id TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          actor_id TEXT,
          actor_type TEXT,
          source_ip TEXT,
          request_id TEXT,
          http_method TEXT,
          http_path TEXT,
          user_agent TEXT,
          metadata JSONB
        )
      `;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS event_id TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_id TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_type TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS source_ip TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS request_id TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS http_method TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS http_path TEXT`;
      await sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS user_agent TEXT`;
      await sql`UPDATE audit_events SET event_id = CONCAT('legacy-', id::text) WHERE event_id IS NULL OR event_id = ''`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS audit_events_event_id_idx ON audit_events (event_id)`;
      await sql`CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events (timestamp DESC)`;
    });
  }

  private async insertPostgres(event: AuditEventRecord): Promise<void> {
    const sql = await this.pgClient();
    try {
      await sql`
        INSERT INTO audit_events (event_id, timestamp, category, action, status, session_id, actor_id, actor_type, source_ip, request_id, http_method, http_path, user_agent, metadata)
        VALUES (
          ${event.event_id ?? randomUUID()},
          ${event.timestamp}::timestamptz,
          ${event.category},
          ${event.action},
          ${event.status},
          ${event.session_id ?? null},
          ${event.actor_id ?? null},
          ${event.actor_type ?? null},
          ${event.source_ip ?? null},
          ${event.request_id ?? null},
          ${event.http_method ?? null},
          ${event.http_path ?? null},
          ${event.user_agent ?? null},
          ${event.metadata ? JSON.stringify(event.metadata) : null}::jsonb
        )
      `;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  private async listPostgres(limit: number): Promise<AuditEventRecord[]> {
    const sql = await this.pgClient();
    try {
      const rows = await sql<
        Array<{
          event_id: string;
          timestamp: string;
          category: AuditCategory;
          action: string;
          status: AuditStatus;
          session_id: string | null;
          actor_id: string | null;
          actor_type: string | null;
          source_ip: string | null;
          request_id: string | null;
          http_method: string | null;
          http_path: string | null;
          user_agent: string | null;
          metadata: Record<string, unknown> | null;
        }>
      >`
        SELECT event_id, timestamp, category, action, status, session_id, actor_id, actor_type, source_ip, request_id, http_method, http_path, user_agent, metadata
        FROM audit_events
        ORDER BY id DESC
        LIMIT ${limit}
      `;

      return rows.map((row) => ({
        event_id: row.event_id,
        timestamp: row.timestamp,
        category: row.category,
        action: row.action,
        status: row.status,
        session_id: row.session_id ?? undefined,
        actor_id: row.actor_id ?? undefined,
        actor_type: row.actor_type ?? undefined,
        source_ip: row.source_ip ?? undefined,
        request_id: row.request_id ?? undefined,
        http_method: row.http_method ?? undefined,
        http_path: row.http_path ?? undefined,
        user_agent: row.user_agent ?? undefined,
        metadata: row.metadata ?? undefined,
      }));
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  private async prunePostgres(): Promise<void> {
    const sql = await this.pgClient();
    try {
      await sql`
        DELETE FROM audit_events
        WHERE id NOT IN (
          SELECT id
          FROM audit_events
          ORDER BY id DESC
          LIMIT ${this.maxRows}
        )
      `;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  private async appendMirror(event: AuditEventRecord): Promise<void> {
    if (!this.mirrorPath) return;

    await this.rotateMirrorIfNeeded();
    await appendFile(this.mirrorPath, `${JSON.stringify(event)}${NEWLINE}`, "utf8");
  }

  private async rotateMirrorIfNeeded(): Promise<void> {
    if (!this.mirrorPath) return;

    const info = await stat(this.mirrorPath).catch(() => null);
    if (!info || info.size < this.rotateBytes) {
      return;
    }

    for (let index = this.rotateFiles; index >= 1; index--) {
      const source = `${this.mirrorPath}.${index}`;
      const target = `${this.mirrorPath}.${index + 1}`;
      if (index === this.rotateFiles) {
        await unlink(source).catch(() => {});
      } else {
        await rename(source, target).catch(() => {});
      }
    }

    await rename(this.mirrorPath, `${this.mirrorPath}.1`).catch(() => {});
  }
}
