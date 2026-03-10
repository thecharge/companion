import { Database } from "bun:sqlite";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "@companion/config";

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
  timestamp: string;
  category: AuditCategory;
  action: string;
  status: AuditStatus;
  session_id?: string;
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
    if (this.cfg.db.driver === "postgres") {
      await this.insertPostgres(event);
      await this.prunePostgres();
    } else {
      this.insertSqlite(event);
      this.pruneSqlite();
    }

    if (this.mirrorPath) {
      await this.appendMirror(event);
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events(timestamp DESC);
      `);
    } finally {
      db.close();
    }
  }

  private insertSqlite(event: AuditEventRecord): void {
    const db = this.sqliteDb();
    try {
      db.prepare(
        "INSERT INTO audit_events (timestamp, category, action, status, session_id, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        event.timestamp,
        event.category,
        event.action,
        event.status,
        event.session_id ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      );
    } finally {
      db.close();
    }
  }

  private listSqlite(limit: number): AuditEventRecord[] {
    const db = this.sqliteDb();
    try {
      const rows = db
        .prepare(
          "SELECT timestamp, category, action, status, session_id, metadata FROM audit_events ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as Array<{
        timestamp: string;
        category: AuditCategory;
        action: string;
        status: AuditStatus;
        session_id: string | null;
        metadata: string | null;
      }>;

      return rows.map((row) => ({
        timestamp: row.timestamp,
        category: row.category,
        action: row.action,
        status: row.status,
        session_id: row.session_id ?? undefined,
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
    const sql = await this.pgClient();
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS audit_events (
          id BIGSERIAL PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          metadata JSONB
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events (timestamp DESC)`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  private async insertPostgres(event: AuditEventRecord): Promise<void> {
    const sql = await this.pgClient();
    try {
      await sql`
        INSERT INTO audit_events (timestamp, category, action, status, session_id, metadata)
        VALUES (${event.timestamp}::timestamptz, ${event.category}, ${event.action}, ${event.status}, ${event.session_id ?? null}, ${event.metadata ? JSON.stringify(event.metadata) : null}::jsonb)
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
          timestamp: string;
          category: AuditCategory;
          action: string;
          status: AuditStatus;
          session_id: string | null;
          metadata: Record<string, unknown> | null;
        }>
      >`
        SELECT timestamp, category, action, status, session_id, metadata
        FROM audit_events
        ORDER BY id DESC
        LIMIT ${limit}
      `;

      return rows.map((row) => ({
        timestamp: row.timestamp,
        category: row.category,
        action: row.action,
        status: row.status,
        session_id: row.session_id ?? undefined,
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
