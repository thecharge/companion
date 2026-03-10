/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Config } from "@companion/config";
import { MessageRole, asMessage } from "@companion/core";
import type { AppContext } from "../bootstrap/app-context";
import { HttpStatus } from "../constants/http";
import { IntegrationBotService } from "./integration-bot-service";

type SessionRow = {
  id: string;
  title: string;
  mode: string;
  message_count: number;
  version: number;
  blackboard: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
};

type HarnessOverrides = Partial<Omit<Config, "integrations">> & {
  integrations?: {
    slack?: Partial<Config["integrations"]["slack"]>;
    telegram?: Partial<Config["integrations"]["telegram"]>;
  };
};

function makeSlackRequest(secret: string, body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return new Request("http://localhost/integrations/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

function makeTelegramRequest(secret: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost/integrations/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(body),
  });
}

function createHarness(partialCfg?: HarnessOverrides) {
  const sessions = new Map<string, SessionRow>();
  const messages = new Map<string, MessageRow[]>();

  const baseCfg: Config = {
    server: {
      port: 3000,
      host: "0.0.0.0",
      secret: "dev-secret",
      idempotency: { enabled: true, ttl_seconds: 86400, max_entries: 10000 },
    },
    db: { driver: "sqlite", sqlite: { path: "./tmp.db" }, postgres: { url: "" } },
    vector: { backend: "sqlite-vec", embedding: { model: "nomic-embed-text", dimensions: 768 } },
    models: {
      local: {
        provider: "ollama",
        model: "qwen3:1.7b",
        base_url: "http://localhost:11434",
        max_tokens: 4096,
        temperature: 0.2,
      },
    },
    orchestrator: {
      model: "local",
      max_rounds: 3,
      verify_results: false,
      workflow_tracks: {},
      roles: { responder: "", promoted_agents: [], skill_worker_agents: [] },
      intent_routes: [],
    },
    agents: {
      responder: {
        model: "local",
        description: "Responder",
        tools: [],
        reads_from: [],
        writes_to: [],
        max_turns: 2,
      },
    },
    memory: {
      context_window: { max_messages: 40, max_tokens: 8000 },
      sliding_window: { chunk_size: 2000, page_size: 20 },
      recall: { top_k: 5, min_score: 0.72, cross_session: false },
      summarisation: { enabled: true, trigger_at_messages: 60, model: "local" },
    },
    mode: { default: "local", presets: { local: { description: "local" } } },
    integrations: {
      slack: {
        enabled: true,
        signing_secret: "slack-secret",
        bot_token: "",
        trusted_user_ids: [],
        trusted_channel_ids: [],
        trusted_team_ids: [],
        required_passphrase: undefined,
        mode: "local",
        default_session_title: "Slack Session",
        max_message_chars: 16000,
        max_events_per_minute: 240,
      },
      telegram: {
        enabled: true,
        secret_token: "telegram-secret",
        bot_token: "",
        trusted_user_ids: [],
        trusted_chat_ids: [],
        required_passphrase: undefined,
        mode: "local",
        default_session_title: "Telegram Session",
        max_message_chars: 16000,
        max_events_per_minute: 240,
      },
    },
    mcp: { enabled: false, servers: {} },
    tools: {},
    sandbox: {
      runtime: "direct",
      allow_direct_fallback: true,
      image: "companion-sandbox:latest",
      network: "none",
      timeout_seconds: 30,
      tests_timeout_seconds: 120,
    },
  };

  const cfg: Config = {
    ...baseCfg,
    ...partialCfg,
    integrations: {
      slack: {
        ...baseCfg.integrations.slack,
        ...(partialCfg?.integrations?.slack ?? {}),
      },
      telegram: {
        ...baseCfg.integrations.telegram,
        ...(partialCfg?.integrations?.telegram ?? {}),
      },
    },
  };

  const db = {
    sessions: {
      get: async (id: string) => sessions.get(id) ?? null,
      list: async () => [...sessions.values()],
      create: async (id: string, title: string, _goal: string, mode: string) => {
        const row: SessionRow = { id, title, mode, message_count: 0, version: 1, blackboard: "{}" };
        sessions.set(id, row);
        return row;
      },
      incrementMessageCount: async (id: string) => {
        const row = sessions.get(id);
        if (row) row.message_count += 1;
      },
    },
    messages: {
      add: async (msg: MessageRow) => {
        const arr = messages.get(msg.session_id) ?? [];
        arr.push(msg);
        messages.set(msg.session_id, arr);
        return msg;
      },
      list: async (sessionId: string, opts?: { limit?: number }) => {
        const arr = messages.get(sessionId) ?? [];
        const limit = opts?.limit ?? arr.length;
        return arr.slice(-limit);
      },
    },
  };

  const sessionMessageService = {
    processMessage: async (sessionId: string, _session: unknown, content: string) => {
      const arr = messages.get(sessionId) ?? [];
      arr.push({
        id: asMessage(`assistant-${arr.length}`),
        session_id: sessionId,
        role: MessageRole.Assistant,
        content: `ACK:${content}`,
      });
      messages.set(sessionId, arr);
    },
  };

  const ctx = {
    cfg,
    db,
  } as unknown as AppContext;

  const service = new IntegrationBotService(ctx, sessionMessageService as never);

  return {
    service,
    getMessages: (): MessageRow[] => [...messages.values()].flat(),
    getSessions: (): SessionRow[] => [...sessions.values()],
  };
}

describe("integration bot service hardening", () => {
  test("slack rejects untrusted user id", async () => {
    const { service } = createHarness({
      integrations: {
        slack: {
          enabled: true,
          signing_secret: "slack-secret",
          bot_token: "",
          trusted_user_ids: ["U-TRUSTED"],
          trusted_channel_ids: [],
          trusted_team_ids: [],
          mode: "local",
          default_session_title: "Slack Session",
          max_message_chars: 16000,
          max_events_per_minute: 240,
        },
      },
    });

    const req = makeSlackRequest("slack-secret", {
      type: "event_callback",
      event_id: "e1",
      team_id: "T1",
      event: { type: "message", text: "hello", channel: "C1", user: "U-BAD" },
    });

    const res = await service.handleSlackWebhook(req);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true, reason: "untrusted_user" });
  });

  test("slack accepts trusted sender with required passphrase", async () => {
    const { service, getMessages, getSessions } = createHarness({
      integrations: {
        slack: {
          enabled: true,
          signing_secret: "slack-secret",
          bot_token: "",
          trusted_user_ids: ["U-TRUSTED"],
          trusted_channel_ids: ["C-TRUSTED"],
          trusted_team_ids: ["T-TRUSTED"],
          required_passphrase: "otp123",
          mode: "local",
          default_session_title: "Slack Session",
          max_message_chars: 2000,
          max_events_per_minute: 30,
        },
      },
    });

    const req = makeSlackRequest("slack-secret", {
      type: "event_callback",
      event_id: "e2",
      team_id: "T-TRUSTED",
      event: {
        type: "message",
        text: "otp123 investigate health endpoint",
        channel: "C-TRUSTED",
        user: "U-TRUSTED",
      },
    });

    const res = await service.handleSlackWebhook(req);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ ok: true });

    const session = getSessions()[0];
    expect(session?.id).toBeString();
    const userMessages = getMessages().filter((m) => m.role === MessageRole.User);
    expect(userMessages[0]?.content).toBe("investigate health endpoint");
  });

  test("telegram rejects invalid secret token", async () => {
    const { service } = createHarness();
    const req = new Request("http://localhost/integrations/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong",
      },
      body: JSON.stringify({ message: { text: "hello", chat: { id: 101 }, from: { id: 99 } } }),
    });

    const res = await service.handleTelegramWebhook(req);
    expect(res.status).toBe(HttpStatus.Unauthorized);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid telegram secret" });
  });

  test("telegram rejects untrusted sender", async () => {
    const { service } = createHarness({
      integrations: {
        telegram: {
          enabled: true,
          secret_token: "telegram-secret",
          bot_token: "",
          trusted_user_ids: [42],
          trusted_chat_ids: [777],
          mode: "local",
          default_session_title: "Telegram Session",
          max_message_chars: 2000,
          max_events_per_minute: 30,
        },
      },
    });

    const req = makeTelegramRequest("telegram-secret", {
      update_id: 900,
      message: { text: "hello", chat: { id: 777 }, from: { id: 999 } },
    });

    const res = await service.handleTelegramWebhook(req);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true, reason: "untrusted_user" });
  });

  test("telegram accepts trusted sender with required passphrase", async () => {
    const { service, getMessages } = createHarness({
      integrations: {
        telegram: {
          enabled: true,
          secret_token: "telegram-secret",
          bot_token: "",
          trusted_user_ids: [42],
          trusted_chat_ids: [777],
          required_passphrase: "otp123",
          mode: "local",
          default_session_title: "Telegram Session",
          max_message_chars: 2000,
          max_events_per_minute: 30,
        },
      },
    });

    const req = makeTelegramRequest("telegram-secret", {
      update_id: 901,
      message: { text: "otp123 run diagnostics", chat: { id: 777 }, from: { id: 42 } },
    });

    const res = await service.handleTelegramWebhook(req);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toMatchObject({ ok: true });

    const userMessages = getMessages().filter((m) => m.role === MessageRole.User);
    expect(userMessages[0]?.content).toBe("run diagnostics");
  });
});
