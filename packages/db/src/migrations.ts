import type { Database } from "bun:sqlite";

export function runSqliteMigration(
  db: Database,
  id: string,
  up: () => void,
  options?: { transactional?: boolean },
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','utc'))
    )
  `);

  const existing = db.prepare("SELECT 1 FROM db_migrations WHERE id = ? LIMIT 1").get(id);
  if (existing) {
    return;
  }

  if (options?.transactional === false) {
    up();
    db.prepare("INSERT INTO db_migrations (id) VALUES (?)").run(id);
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    up();
    db.prepare("INSERT INTO db_migrations (id) VALUES (?)").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function runPostgresMigration(
  url: string,
  id: string,
  up: (sql: Awaited<ReturnType<typeof importPostgres>>) => Promise<void>,
): Promise<void> {
  const sql = await importPostgres(url);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS db_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const existing = await sql<{ id: string }[]>`
      SELECT id FROM db_migrations WHERE id = ${id} LIMIT 1
    `;
    if (existing.length > 0) {
      return;
    }

    await up(sql);
    await sql`INSERT INTO db_migrations (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING`;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function importPostgres(url: string) {
  const module = await import("postgres");
  return module.default(url, { max: 1, idle_timeout: 5 });
}
