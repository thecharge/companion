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

export class IntegrationBotService {
  private externalSessions = new Map<string, SessionId>();
  private replayGuard = new ReplayGuard(INTEGRATION_LIMITS.replayWindowMs);
  private slackLimiter: SlidingWindowLimiter;
  private telegramLimiter: SlidingWindowLimiter;

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
      return Response.json({ ok: false, error: "slack integration disabled" }, { status: HttpStatus.NotFound });
    }

    if (!this.ctx.cfg.integrations.slack.signing_secret) {
      return Response.json({ ok: false, error: "slack signing secret is required" }, { status: HttpStatus.BadRequest });
    }
    if (!isJsonContentType(req)) {
      return Response.json(
        { ok: false, error: "content-type must be application/json" },
        { status: HttpStatus.BadRequest },
      );
    }

    const rawBody = await req.text();
    if (!withinWebhookBodyLimit(rawBody)) {
      return Response.json({ ok: false, error: "payload too large" }, { status: HttpStatus.BadRequest });
    }
    if (!this.verifySlackSignature(req, rawBody)) {
      return Response.json({ ok: false, error: "invalid slack signature" }, { status: HttpStatus.Unauthorized });
    }

    const body = this.safeJson<SlackEventBody>(rawBody);
    if (!body) {
      return Response.json({ ok: false, error: "invalid JSON payload" }, { status: HttpStatus.BadRequest });
    }

    if (body.type === "url_verification" && body.challenge) {
      return new Response(body.challenge, { status: HttpStatus.Ok, headers: { "Content-Type": "text/plain" } });
    }

    if (body.event_id && this.replayGuard.isReplay("slack", body.event_id)) {
      return Response.json({ ok: true, ignored: true, reason: "replay" });
    }

    const ev = body.event;
    if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id || !ev.text || !ev.channel) {
      return Response.json({ ok: true, ignored: true });
    }

    if (!this.slackLimiter.allow(`slack:${ev.channel}`)) {
      return Response.json({ ok: true, ignored: true, reason: "rate_limited" });
    }

    const guarded = guardInboundMessage(ev.text, this.ctx.cfg.integrations.slack.max_message_chars);
    if (!guarded.ok || !guarded.text) {
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

    return Response.json({ ok: true });
  }

  async handleTelegramWebhook(req: Request): Promise<Response> {
    if (!this.ctx.cfg.integrations.telegram.enabled) {
      return Response.json({ ok: false, error: "telegram integration disabled" }, { status: HttpStatus.NotFound });
    }

    if (!this.ctx.cfg.integrations.telegram.secret_token) {
      return Response.json(
        { ok: false, error: "telegram secret token is required" },
        { status: HttpStatus.BadRequest },
      );
    }
    if (!isJsonContentType(req)) {
      return Response.json(
        { ok: false, error: "content-type must be application/json" },
        { status: HttpStatus.BadRequest },
      );
    }

    const configuredSecret = this.ctx.cfg.integrations.telegram.secret_token;
    const supplied = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!supplied || supplied !== configuredSecret) {
      return Response.json({ ok: false, error: "invalid telegram secret" }, { status: HttpStatus.Unauthorized });
    }

    const rawBody = await req.text();
    if (!withinWebhookBodyLimit(rawBody)) {
      return Response.json({ ok: false, error: "payload too large" }, { status: HttpStatus.BadRequest });
    }

    const body = this.safeJson<TelegramBody>(rawBody);
    if (!body?.message?.text || !body.message.chat?.id) {
      return Response.json({ ok: true, ignored: true });
    }

    if (typeof body.update_id === "number" && this.replayGuard.isReplay("telegram", String(body.update_id))) {
      return Response.json({ ok: true, ignored: true, reason: "replay" });
    }

    const chatId = String(body.message.chat.id);
    const text = body.message.text;

    if (!this.telegramLimiter.allow(`telegram:${chatId}`)) {
      return Response.json({ ok: true, ignored: true, reason: "rate_limited" });
    }

    const guarded = guardInboundMessage(text, this.ctx.cfg.integrations.telegram.max_message_chars);
    if (!guarded.ok || !guarded.text) {
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

    return Response.json({ ok: true });
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
