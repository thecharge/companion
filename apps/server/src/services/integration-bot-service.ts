/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { MessageRole, type SessionId, type SessionMode, asMessage, asSession, newId } from "@companion/core";
import type { AppContext } from "../bootstrap/app-context";
import { HeaderName, HttpStatus } from "../constants/http";
import { INTEGRATION_LIMITS } from "./integrations/constants";
import {
  ReplayGuard,
  SlidingWindowLimiter,
  guardInboundMessage,
  isJsonContentType,
  withinWebhookBodyLimit,
} from "./integrations/guards";
import { verifySlackSignature } from "./integrations/signatures";
import type { SessionMessageService } from "./session-message-service";

interface SlackEventBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    text?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
  };
}

interface TelegramBody {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number };
    from?: { id?: number };
  };
}

interface PassphraseResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

type TelemetryOutcome = "accepted" | "ignored" | "rejected";

interface ProviderTelemetry {
  total: number;
  accepted: number;
  ignored: number;
  rejected: number;
  reasons: Record<string, number>;
  last_event_at?: string;
}

export class IntegrationBotService {
  private externalSessions = new Map<string, SessionId>();
  private replayGuard = new ReplayGuard(INTEGRATION_LIMITS.replayWindowMs);
  private slackLimiter: SlidingWindowLimiter;
  private telegramLimiter: SlidingWindowLimiter;
  private telemetry: Record<"slack" | "telegram", ProviderTelemetry> = {
    slack: { total: 0, accepted: 0, ignored: 0, rejected: 0, reasons: {} },
    telegram: { total: 0, accepted: 0, ignored: 0, rejected: 0, reasons: {} },
  };

  constructor(
    private ctx: AppContext,
    private sessionMessageService: SessionMessageService,
  ) {
    this.slackLimiter = new SlidingWindowLimiter(
      this.ctx.cfg.integrations.slack.max_events_per_minute,
      INTEGRATION_LIMITS.rateWindowMs,
    );
    this.telegramLimiter = new SlidingWindowLimiter(
      this.ctx.cfg.integrations.telegram.max_events_per_minute,
      INTEGRATION_LIMITS.rateWindowMs,
    );
  }

  async handleSlackWebhook(req: Request): Promise<Response> {
    if (!this.ctx.cfg.integrations.slack.enabled) {
      this.recordTelemetry("slack", "rejected", "disabled");
      return Response.json({ ok: false, error: "slack integration disabled" }, { status: HttpStatus.NotFound });
    }

    if (!this.ctx.cfg.integrations.slack.signing_secret) {
      this.recordTelemetry("slack", "rejected", "missing_signing_secret");
      return Response.json({ ok: false, error: "slack signing secret is required" }, { status: HttpStatus.BadRequest });
    }
    if (!isJsonContentType(req)) {
      this.recordTelemetry("slack", "rejected", "invalid_content_type");
      return Response.json(
        { ok: false, error: "content-type must be application/json" },
        { status: HttpStatus.BadRequest },
      );
    }

    const rawBody = await req.text();
    if (!withinWebhookBodyLimit(rawBody)) {
      this.recordTelemetry("slack", "rejected", "payload_too_large");
      return Response.json({ ok: false, error: "payload too large" }, { status: HttpStatus.BadRequest });
    }
    if (!this.verifySlackSignature(req, rawBody)) {
      this.recordTelemetry("slack", "rejected", "invalid_signature");
      return Response.json({ ok: false, error: "invalid slack signature" }, { status: HttpStatus.Unauthorized });
    }

    const body = this.safeJson<SlackEventBody>(rawBody);
    if (!body) {
      this.recordTelemetry("slack", "rejected", "invalid_json");
      return Response.json({ ok: false, error: "invalid JSON payload" }, { status: HttpStatus.BadRequest });
    }

    if (body.type === "url_verification" && body.challenge) {
      this.recordTelemetry("slack", "accepted", "url_verification");
      return new Response(body.challenge, { status: HttpStatus.Ok, headers: { "Content-Type": "text/plain" } });
    }

    if (body.event_id && this.replayGuard.isReplay("slack", body.event_id)) {
      this.recordTelemetry("slack", "ignored", "replay");
      return Response.json({ ok: true, ignored: true, reason: "replay" });
    }

    const ev = body.event;
    if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id || !ev.text || !ev.channel || !ev.user) {
      this.recordTelemetry("slack", "ignored", "non_message_event");
      return Response.json({ ok: true, ignored: true });
    }

    const slackTrust = this.enforceSlackTrust({
      userId: ev.user,
      channelId: ev.channel,
      teamId: body.team_id,
    });
    if (!slackTrust.ok) {
      this.recordTelemetry("slack", "ignored", slackTrust.reason ?? "untrusted_sender");
      return Response.json({ ok: true, ignored: true, reason: slackTrust.reason ?? "untrusted_sender" });
    }

    const slackPassphrase = this.applyRequiredPassphrase(ev.text, this.ctx.cfg.integrations.slack.required_passphrase);
    if (!slackPassphrase.ok || !slackPassphrase.text) {
      this.recordTelemetry("slack", "ignored", slackPassphrase.reason ?? "missing_passphrase");
      return Response.json({ ok: true, ignored: true, reason: slackPassphrase.reason ?? "missing_passphrase" });
    }

    if (!this.slackLimiter.allow(`slack:${ev.channel}`)) {
      this.recordTelemetry("slack", "ignored", "rate_limited");
      return Response.json({ ok: true, ignored: true, reason: "rate_limited" });
    }

    const guarded = guardInboundMessage(slackPassphrase.text, this.ctx.cfg.integrations.slack.max_message_chars);
    if (!guarded.ok || !guarded.text) {
      this.recordTelemetry("slack", "ignored", guarded.reason ?? "guard_rejected");
      return Response.json({ ok: true, ignored: true, reason: guarded.reason ?? "guard_rejected" });
    }

    const externalId = `slack:${ev.channel}`;
    const session = await this.ensureSession(
      externalId,
      this.ctx.cfg.integrations.slack.default_session_title,
      "slack",
    );
    const assistantReply = await this.processInboundMessage(session.id, guarded.text, process.cwd());

    const token = this.ctx.cfg.integrations.slack.bot_token;
    if (token && assistantReply) {
      await this.postSlackMessage(token, ev.channel, assistantReply);
    }

    this.recordTelemetry("slack", "accepted", "message_processed");
    return Response.json({ ok: true });
  }

  async handleTelegramWebhook(req: Request): Promise<Response> {
    if (!this.ctx.cfg.integrations.telegram.enabled) {
      this.recordTelemetry("telegram", "rejected", "disabled");
      return Response.json({ ok: false, error: "telegram integration disabled" }, { status: HttpStatus.NotFound });
    }

    if (!this.ctx.cfg.integrations.telegram.secret_token) {
      this.recordTelemetry("telegram", "rejected", "missing_secret_token");
      return Response.json(
        { ok: false, error: "telegram secret token is required" },
        { status: HttpStatus.BadRequest },
      );
    }
    if (!isJsonContentType(req)) {
      this.recordTelemetry("telegram", "rejected", "invalid_content_type");
      return Response.json(
        { ok: false, error: "content-type must be application/json" },
        { status: HttpStatus.BadRequest },
      );
    }

    const configuredSecret = this.ctx.cfg.integrations.telegram.secret_token;
    const supplied = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!supplied || supplied !== configuredSecret) {
      this.recordTelemetry("telegram", "rejected", "invalid_secret");
      return Response.json({ ok: false, error: "invalid telegram secret" }, { status: HttpStatus.Unauthorized });
    }

    const rawBody = await req.text();
    if (!withinWebhookBodyLimit(rawBody)) {
      this.recordTelemetry("telegram", "rejected", "payload_too_large");
      return Response.json({ ok: false, error: "payload too large" }, { status: HttpStatus.BadRequest });
    }

    const body = this.safeJson<TelegramBody>(rawBody);
    if (!body?.message?.text || !body.message.chat?.id) {
      this.recordTelemetry("telegram", "ignored", "non_message_event");
      return Response.json({ ok: true, ignored: true });
    }

    if (typeof body.update_id === "number" && this.replayGuard.isReplay("telegram", String(body.update_id))) {
      this.recordTelemetry("telegram", "ignored", "replay");
      return Response.json({ ok: true, ignored: true, reason: "replay" });
    }

    const chatId = String(body.message.chat.id);
    const fromUserId = body.message.from?.id;

    const telegramTrust = this.enforceTelegramTrust({ chatId: body.message.chat.id, fromUserId });
    if (!telegramTrust.ok) {
      this.recordTelemetry("telegram", "ignored", telegramTrust.reason ?? "untrusted_sender");
      return Response.json({ ok: true, ignored: true, reason: telegramTrust.reason ?? "untrusted_sender" });
    }

    const telegramPassphrase = this.applyRequiredPassphrase(
      body.message.text,
      this.ctx.cfg.integrations.telegram.required_passphrase,
    );
    if (!telegramPassphrase.ok || !telegramPassphrase.text) {
      this.recordTelemetry("telegram", "ignored", telegramPassphrase.reason ?? "missing_passphrase");
      return Response.json({ ok: true, ignored: true, reason: telegramPassphrase.reason ?? "missing_passphrase" });
    }

    if (!this.telegramLimiter.allow(`telegram:${chatId}`)) {
      this.recordTelemetry("telegram", "ignored", "rate_limited");
      return Response.json({ ok: true, ignored: true, reason: "rate_limited" });
    }

    const guarded = guardInboundMessage(telegramPassphrase.text, this.ctx.cfg.integrations.telegram.max_message_chars);
    if (!guarded.ok || !guarded.text) {
      this.recordTelemetry("telegram", "ignored", guarded.reason ?? "guard_rejected");
      return Response.json({ ok: true, ignored: true, reason: guarded.reason ?? "guard_rejected" });
    }

    const externalId = `telegram:${chatId}`;
    const session = await this.ensureSession(
      externalId,
      this.ctx.cfg.integrations.telegram.default_session_title,
      "telegram",
    );
    const assistantReply = await this.processInboundMessage(session.id, guarded.text, process.cwd());

    const botToken = this.ctx.cfg.integrations.telegram.bot_token;
    if (botToken && assistantReply) {
      await this.postTelegramMessage(botToken, chatId, assistantReply);
    }

    this.recordTelemetry("telegram", "accepted", "message_processed");
    return Response.json({ ok: true });
  }

  getTelemetryConfig(): Record<string, unknown> {
    const slack = this.ctx.cfg.integrations.slack;
    const telegram = this.ctx.cfg.integrations.telegram;
    return {
      generated_at: new Date().toISOString(),
      slack: {
        enabled: slack.enabled,
        mode: slack.mode ?? this.ctx.cfg.mode.default,
        default_session_title: slack.default_session_title,
        max_message_chars: slack.max_message_chars,
        max_events_per_minute: slack.max_events_per_minute,
        trusted_user_ids_count: slack.trusted_user_ids.length,
        trusted_channel_ids_count: slack.trusted_channel_ids.length,
        trusted_team_ids_count: slack.trusted_team_ids.length,
        has_signing_secret: Boolean(slack.signing_secret),
        has_bot_token: Boolean(slack.bot_token),
        passphrase_required: Boolean(slack.required_passphrase),
        webhook_path: "/integrations/slack/events",
      },
      telegram: {
        enabled: telegram.enabled,
        mode: telegram.mode ?? this.ctx.cfg.mode.default,
        default_session_title: telegram.default_session_title,
        max_message_chars: telegram.max_message_chars,
        max_events_per_minute: telegram.max_events_per_minute,
        trusted_user_ids_count: telegram.trusted_user_ids.length,
        trusted_chat_ids_count: telegram.trusted_chat_ids.length,
        has_secret_token: Boolean(telegram.secret_token),
        has_bot_token: Boolean(telegram.bot_token),
        passphrase_required: Boolean(telegram.required_passphrase),
        webhook_path: "/integrations/telegram/webhook",
      },
    };
  }

  getTelemetryStats(): Record<string, unknown> {
    return {
      generated_at: new Date().toISOString(),
      slack: this.telemetry.slack,
      telegram: this.telemetry.telegram,
    };
  }

  private recordTelemetry(source: "slack" | "telegram", outcome: TelemetryOutcome, reason?: string): void {
    const t = this.telemetry[source];
    t.total += 1;
    t[outcome] += 1;
    t.last_event_at = new Date().toISOString();
    if (reason) {
      t.reasons[reason] = (t.reasons[reason] ?? 0) + 1;
    }
  }

  private verifySlackSignature(req: Request, rawBody: string): boolean {
    const secret = this.ctx.cfg.integrations.slack.signing_secret;
    if (!secret) return false;

    const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
    const signature = req.headers.get("x-slack-signature") ?? "";
    return verifySlackSignature(secret, timestamp, signature, rawBody);
  }

  private safeJson<T>(raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private enforceSlackTrust(input: { userId: string; channelId: string; teamId?: string }): {
    ok: boolean;
    reason?: string;
  } {
    const trust = this.ctx.cfg.integrations.slack;
    if (trust.trusted_user_ids.length > 0 && !trust.trusted_user_ids.includes(input.userId)) {
      return { ok: false, reason: "untrusted_user" };
    }
    if (trust.trusted_channel_ids.length > 0 && !trust.trusted_channel_ids.includes(input.channelId)) {
      return { ok: false, reason: "untrusted_channel" };
    }
    if (trust.trusted_team_ids.length > 0) {
      if (!input.teamId || !trust.trusted_team_ids.includes(input.teamId)) {
        return { ok: false, reason: "untrusted_team" };
      }
    }
    return { ok: true };
  }

  private enforceTelegramTrust(input: { chatId: number; fromUserId?: number }): {
    ok: boolean;
    reason?: string;
  } {
    const trust = this.ctx.cfg.integrations.telegram;
    if (trust.trusted_user_ids.length > 0) {
      if (typeof input.fromUserId !== "number" || !trust.trusted_user_ids.includes(input.fromUserId)) {
        return { ok: false, reason: "untrusted_user" };
      }
    }
    if (trust.trusted_chat_ids.length > 0 && !trust.trusted_chat_ids.includes(input.chatId)) {
      return { ok: false, reason: "untrusted_chat" };
    }
    return { ok: true };
  }

  private applyRequiredPassphrase(text: string, passphrase?: string): PassphraseResult {
    if (!passphrase) {
      return { ok: true, text };
    }

    const trimmed = text.trim();
    const prefix = `${passphrase} `;
    if (trimmed === passphrase) {
      return { ok: false, reason: "missing_message_after_passphrase" };
    }
    if (!trimmed.startsWith(prefix)) {
      return { ok: false, reason: "missing_passphrase" };
    }

    const stripped = trimmed.slice(prefix.length).trim();
    if (!stripped) {
      return { ok: false, reason: "empty_content" };
    }
    return { ok: true, text: stripped };
  }

  private async ensureSession(
    externalId: string,
    titlePrefix: string,
    source: "slack" | "telegram",
  ): Promise<Awaited<ReturnType<AppContext["db"]["sessions"]["get"]>> & { id: SessionId }> {
    const cached = this.externalSessions.get(externalId);
    if (cached) {
      const existing = await this.ctx.db.sessions.get(cached);
      if (existing) return existing;
      this.externalSessions.delete(externalId);
    }

    const marker = `[${externalId}]`;
    const known = await this.ctx.db.sessions.list({ limit: 500 });
    const matched = known.find((session) => session.title.includes(marker));
    if (matched) {
      this.externalSessions.set(externalId, matched.id);
      return matched;
    }

    const sid = asSession(newId());
    const mode = (this.integrationMode(source) ?? this.ctx.cfg.mode.default) as SessionMode;
    const title = `${titlePrefix} ${marker}`;
    const created = await this.ctx.db.sessions.create(sid, title, `${source} channel conversation`, mode);
    this.externalSessions.set(externalId, created.id);
    return created;
  }

  private integrationMode(source: "slack" | "telegram"): string | undefined {
    if (source === "slack") return this.ctx.cfg.integrations.slack.mode;
    return this.ctx.cfg.integrations.telegram.mode;
  }

  private async processInboundMessage(sessionId: SessionId, text: string, workingDir: string): Promise<string> {
    const userMessage = await this.ctx.db.messages.add({
      id: asMessage(newId()),
      session_id: sessionId,
      role: MessageRole.User,
      content: text,
    });
    await this.ctx.db.sessions.incrementMessageCount(sessionId);

    const session = await this.ctx.db.sessions.get(sessionId);
    if (!session) return "";

    await this.sessionMessageService.processMessage(sessionId, session, userMessage.content, workingDir);
    const messages = await this.ctx.db.messages.list(sessionId, { limit: 20 });
    const reply = [...messages].reverse().find((message) => message.role === MessageRole.Assistant)?.content;
    return reply ?? "";
  }

  private async postSlackMessage(token: string, channel: string, text: string): Promise<void> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        [HeaderName.ContentType]: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`Slack post failed HTTP ${response.status}`);
    }
  }

  private async postTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { [HeaderName.ContentType]: "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`Telegram post failed HTTP ${response.status}`);
    }
  }
}
