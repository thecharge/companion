import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@companion/config";
import { AuditLogRepository } from "./audit-log-repository";

function makeConfig(dbPath: string): Config {
  return {
    server: {
      port: 3000,
      host: "127.0.0.1",
      secret: "test",
      idempotency: { enabled: true, ttl_seconds: 86400, max_entries: 10000 },
    },
    db: { driver: "sqlite", sqlite: { path: dbPath }, postgres: { url: "" } },
    vector: { backend: "sqlite-vec", embedding: { model: "embed", dimensions: 3 } },
    models: { local: { provider: "ollama", model: "qwen3:1.7b", max_tokens: 100, temperature: 0 } },
    orchestrator: {
      model: "local",
      max_rounds: 1,
      verify_results: false,
      workflow_tracks: {},
      roles: { responder: "", promoted_agents: [], skill_worker_agents: [] },
      intent_routes: [],
    },
    agents: {},
    memory: {
      context_window: { max_messages: 10, max_tokens: 1000 },
      sliding_window: { chunk_size: 200, page_size: 10 },
      recall: { top_k: 2, min_score: 0.5, cross_session: false },
      summarisation: { enabled: false, trigger_at_messages: 999, model: "local" },
    },
    mode: { default: "local", presets: { local: { description: "local" } } },
    integrations: {
      slack: {
        enabled: false,
        trusted_user_ids: [],
        trusted_channel_ids: [],
        trusted_team_ids: [],
        default_session_title: "Slack Session",
        max_message_chars: 2000,
        max_events_per_minute: 30,
      },
      telegram: {
        enabled: false,
        trusted_user_ids: [],
        trusted_chat_ids: [],
        default_session_title: "Telegram Session",
        max_message_chars: 2000,
        max_events_per_minute: 30,
      },
    },
    tools: {},
    sandbox: {
      runtime: "direct",
      allow_direct_fallback: true,
      image: "companion-sandbox:latest",
      network: "none",
      timeout_seconds: 30,
      tests_timeout_seconds: 60,
    },
  };
}

describe("audit log repository", () => {
  test("stores records and reads recent events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-audit-repo-"));
    const dbPath = join(dir, "audit.db");
    const cfg = makeConfig(dbPath);
    const repo = new AuditLogRepository({ cfg });

    await repo.initialize();
    await repo.record({
      timestamp: new Date().toISOString(),
      category: "http",
      action: "session_create",
      status: "ok",
    });

    const events = await repo.listRecent(5);
    expect(events.length).toBe(1);
    expect(events[0]?.action).toBe("session_create");

    await rm(dir, { recursive: true, force: true });
  });

  test("rotates mirror file when size threshold is exceeded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-audit-rotate-"));
    const dbPath = join(dir, "audit.db");
    const mirrorPath = join(dir, "audit.ndjson");
    const cfg = makeConfig(dbPath);
    const repo = new AuditLogRepository({ cfg, mirrorPath, rotateBytes: 120, rotateFiles: 2 });

    await repo.initialize();

    for (let i = 0; i < 10; i++) {
      await repo.record({
        timestamp: new Date().toISOString(),
        category: "http",
        action: `event_${i}`,
        status: "ok",
      });
    }

    const rotated = await readFile(`${mirrorPath}.1`, "utf8").catch(() => "");
    expect(rotated.length > 0).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("upgrades legacy sqlite audit schema to include who/where columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-audit-legacy-"));
    const dbPath = join(dir, "audit.db");

    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        metadata TEXT
      )
    `);
    db.close();

    const cfg = makeConfig(dbPath);
    const repo = new AuditLogRepository({ cfg });
    await repo.initialize();
    await repo.record({
      timestamp: new Date().toISOString(),
      category: "http",
      action: "legacy_upgrade",
      status: "ok",
      actor_id: "tester",
      http_path: "/legacy",
    });

    const events = await repo.listRecent(5);
    expect(events[0]?.action).toBe("legacy_upgrade");
    expect(events[0]?.actor_id).toBe("tester");
    expect(events[0]?.http_path).toBe("/legacy");

    await rm(dir, { recursive: true, force: true });
  });
});
