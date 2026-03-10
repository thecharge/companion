/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@companion/config";
import { AuditLogRepository } from "@companion/db";
import { AuditLogService } from "./audit-log-service";

function createConfig(dbPath: string): Config {
  return {
    server: {
      port: 3000,
      host: "127.0.0.1",
      secret: "test",
      idempotency: { enabled: true, ttl_seconds: 86400, max_entries: 10000 },
    },
    db: { driver: "sqlite", sqlite: { path: dbPath }, postgres: { url: "" } },
    vector: { backend: "sqlite-vec", embedding: { model: "embed", dimensions: 3 } },
    models: {
      local: { provider: "ollama", model: "qwen3:1.7b", max_tokens: 100, temperature: 0 },
    },
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

describe("audit log service", () => {
  test("writes and reads recent records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-audit-"));
    const logPath = join(dir, "audit.ndjson");
    const cfg = createConfig(join(dir, "data.db"));
    const repository = new AuditLogRepository({ cfg, mirrorPath: logPath });
    const service = new AuditLogService(repository);

    await service.initialize();
    await service.record({
      timestamp: new Date().toISOString(),
      category: "http",
      action: "sessions_list",
      status: "ok",
    });

    const records = await service.listRecent(10);
    expect(records.length).toBe(1);
    expect(records[0]?.action).toBe("sessions_list");

    await rm(dir, { recursive: true, force: true });
  });

  test("captures who and where fields for HTTP audit events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-audit-http-"));
    const logPath = join(dir, "audit.ndjson");
    const cfg = createConfig(join(dir, "data.db"));
    const repository = new AuditLogRepository({ cfg, mirrorPath: logPath });
    const service = new AuditLogService(repository);

    const request = new Request("http://localhost:3000/sessions?limit=10", {
      method: "GET",
      headers: {
        "x-user-id": "u-123",
        "x-forwarded-for": "203.0.113.10",
        "x-request-id": "req-1",
        "user-agent": "companion-test",
      },
    });

    await service.initialize();
    await service.recordHttpEvent({ action: "sessions_list", status: "ok", request });
    const records = await service.listRecent(10);

    expect(records[0]?.actor_id).toBe("u-123");
    expect(records[0]?.http_path).toBe("/sessions");
    expect(records[0]?.source_ip).toBe("203.0.113.10");
    expect(records[0]?.request_id).toBe("req-1");

    await rm(dir, { recursive: true, force: true });
  });
});
