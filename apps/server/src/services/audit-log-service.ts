/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CompanionEvent, EventType, type SessionId } from "@companion/core";

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

const NEWLINE = "\n";
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
  constructor(private readonly logFilePath: string) {}

  initialize = async (): Promise<void> => {
    await mkdir(dirname(this.logFilePath), { recursive: true });
    const file = Bun.file(this.logFilePath);

    if (!(await file.exists())) {
      await Bun.write(this.logFilePath, "");
    }
  };

  record = async (event: AuditEventRecord): Promise<void> => {
    const payload = JSON.stringify(event);
    await appendFile(this.logFilePath, `${payload}${NEWLINE}`, "utf8");
  };

  recordHttpEvent = async (params: {
    action: string;
    status: AuditStatus;
    sessionId?: SessionId;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    await this.record({
      timestamp: new Date().toISOString(),
      category: AuditCategory.Http,
      action: params.action,
      status: params.status,
      session_id: params.sessionId,
      metadata: params.metadata,
    });
  };

  recordBusEvent = async (event: CompanionEvent): Promise<void> => {
    const mapped = this.mapBusEvent(event.type);
    await this.record({
      timestamp: event.ts.toISOString(),
      category: mapped.category,
      action: mapped.action,
      status: mapped.status,
      session_id: event.session_id,
      metadata: { type: event.type },
    });
  };

  listRecent = async (limit?: number): Promise<AuditEventRecord[]> => {
    const content = await readFile(this.logFilePath, "utf8").catch(() => "");
    const lines = content
      .split(NEWLINE)
      .map((line) => line.trim())
      .filter(Boolean);

    const records = lines
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEventRecord;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEventRecord => entry !== null);

    const effectiveLimit = normalizeAuditLimit(limit);
    return records.slice(Math.max(0, records.length - effectiveLimit));
  };

  private mapBusEvent = (type: EventType): { category: AuditCategory; action: string; status: AuditStatus } => {
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
}
