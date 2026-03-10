export const SQLITE_CORE_SCHEMA = `
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

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  id, title, summary,
  content='sessions',
  content_rowid='rowid'
);

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

export async function applyPostgresCoreSchema(sql: any): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Session',
      status TEXT NOT NULL DEFAULT 'active',
      mode TEXT NOT NULL DEFAULT 'local',
      blackboard TEXT NOT NULL DEFAULT '{}',
      summary TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls JSONB,
      tool_call_id TEXT,
      name TEXT,
      tokens INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, created_at)`;
}
