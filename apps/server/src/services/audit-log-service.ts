/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { type CompanionEvent, EventType, type SessionId, newId } from "@companion/core";
import {
  AuditCategory,
  type AuditCategory as AuditCategoryType,
  type AuditEventRecord,
  type AuditLogRepository,
  AuditStatus,
  type AuditStatus as AuditStatusType,
} from "@companion/db";
const MAX_AUDIT_LIMIT = getLimitFromEnv("AUDIT_LOG_MAX_LIMIT", 1_000);
const DEFAULT_AUDIT_LIMIT = getLimitFromEnv("AUDIT_LOG_DEFAULT_LIMIT", 100);

function getLimitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function normalizeAuditLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_AUDIT_LIMIT;
  if (!limit || limit < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.trunc(limit), MAX_AUDIT_LIMIT);
}

export class AuditLogService {
  constructor(private readonly repository: AuditLogRepository) {}

  initialize = async (): Promise<void> => {
    await this.repository.initialize();
  };

  record = async (event: AuditEventRecord): Promise<void> => {
    await this.repository.record(event);
  };

  recordHttpEvent = async (params: {
    action: string;
    status: AuditStatusType;
    request?: Request;
    sessionId?: SessionId;
    actorId?: string;
    actorType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    const httpContext = this.extractHttpContext(params.request);

    await this.record({
      event_id: newId(),
      timestamp: new Date().toISOString(),
      category: AuditCategory.Http,
      action: params.action,
      status: params.status,
      session_id: params.sessionId,
      actor_id: params.actorId ?? httpContext.actorId,
      actor_type: params.actorType ?? httpContext.actorType,
      source_ip: httpContext.sourceIp,
      request_id: httpContext.requestId,
      http_method: httpContext.method,
      http_path: httpContext.path,
      user_agent: httpContext.userAgent,
      metadata: {
        ...params.metadata,
        query: httpContext.query,
      },
    });
  };

  recordBusEvent = async (event: CompanionEvent): Promise<void> => {
    const mapped = this.mapBusEvent(event.type);
    const metadata = this.extractBusMetadata(event.type, event.payload);
    await this.record({
      event_id: newId(),
      timestamp: event.ts.toISOString(),
      category: mapped.category,
      action: mapped.action,
      status: mapped.status,
      session_id: event.session_id,
      actor_type: "system",
      metadata,
    });
  };

  listRecent = async (limit?: number): Promise<AuditEventRecord[]> => {
    const effectiveLimit = normalizeAuditLimit(limit);
    return this.repository.listRecent(effectiveLimit);
  };

  private mapBusEvent = (type: EventType): { category: AuditCategoryType; action: string; status: AuditStatusType } => {
    if (type === EventType.AgentStart) {
      return { category: AuditCategory.Agent, action: "agent_start", status: AuditStatus.Ok };
    }
    if (type === EventType.AgentEnd) {
      return { category: AuditCategory.Agent, action: "agent_end", status: AuditStatus.Ok };
    }
    if (type === EventType.AgentThought) {
      return { category: AuditCategory.Agent, action: "agent_thought", status: AuditStatus.Ok };
    }
    if (type === EventType.ToolStart) {
      return { category: AuditCategory.Tool, action: "tool_start", status: AuditStatus.Ok };
    }
    if (type === EventType.ToolEnd) {
      return { category: AuditCategory.Tool, action: "tool_end", status: AuditStatus.Ok };
    }
    if (type === EventType.SessionUpdate) {
      return { category: AuditCategory.Session, action: "session_update", status: AuditStatus.Ok };
    }
    if (type === EventType.Error) {
      return { category: AuditCategory.Error, action: "error", status: AuditStatus.Error };
    }
    if (type === EventType.Message) {
      return { category: AuditCategory.Session, action: "message", status: AuditStatus.Ok };
    }
    return { category: AuditCategory.Session, action: "event", status: AuditStatus.Ok };
  };

  private extractBusMetadata = (type: EventType, payload: unknown): Record<string, unknown> => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const base: Record<string, unknown> = { type };

    if (type === EventType.AgentStart || type === EventType.AgentEnd) {
      return {
        ...base,
        agent: p.agent ? String(p.agent) : undefined,
        model: p.model ? String(p.model) : undefined,
        stopped_reason: p.stopped_reason ? String(p.stopped_reason) : undefined,
      };
    }

    if (type === EventType.AgentThought) {
      const text = p.text ? String(p.text) : "";
      return {
        ...base,
        agent: p.agent ? String(p.agent) : undefined,
        text_preview: text.slice(0, 180),
      };
    }

    if (type === EventType.ToolStart || type === EventType.ToolEnd) {
      return {
        ...base,
        agent: p.agent ? String(p.agent) : undefined,
        tool: p.tool ? String(p.tool) : undefined,
        duration_ms: Number.isFinite(Number(p.duration_ms)) ? Number(p.duration_ms) : undefined,
        error: p.error ? String(p.error).slice(0, 180) : undefined,
      };
    }

    if (type === EventType.Error) {
      return {
        ...base,
        error: p.error ? String(p.error).slice(0, 240) : undefined,
      };
    }

    return base;
  };

  private extractHttpContext = (
    request?: Request,
  ): {
    actorId?: string;
    actorType?: string;
    sourceIp?: string;
    requestId?: string;
    method?: string;
    path?: string;
    userAgent?: string;
    query?: string;
  } => {
    if (!request) {
      return {};
    }

    const headers = request.headers;
    const forwarded = headers.get("x-forwarded-for") ?? "";
    const sourceIp = (forwarded.split(",")[0]?.trim() || headers.get("x-real-ip")) ?? undefined;
    const actorId =
      headers.get("x-companion-actor-id") ??
      headers.get("x-user-id") ??
      headers.get("x-slack-user-id") ??
      headers.get("x-telegram-user-id") ??
      undefined;

    const actorType =
      headers.get("x-companion-actor-type") ??
      (headers.has("x-slack-signature") || headers.has("x-telegram-bot-api-secret-token")
        ? "integration"
        : headers.has("authorization") || headers.has("x-api-key")
          ? "service"
          : undefined);

    const url = new URL(request.url);
    return {
      actorId,
      actorType,
      sourceIp,
      requestId: headers.get("x-request-id") ?? undefined,
      method: request.method,
      path: url.pathname,
      query: url.search,
      userAgent: headers.get("user-agent") ?? undefined,
    };
  };
}
