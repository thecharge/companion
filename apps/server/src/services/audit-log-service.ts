/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EventType, type CompanionEvent, type SessionId } from "@companion/core";

export interface AuditEventRecord {
  timestamp: string;
  category: "http" | "agent" | "tool" | "session" | "error";
  action: string;
  status: "ok" | "error";
  session_id?: string;
  metadata?: Record<string, unknown>;
}

const NEWLINE = "\n";
const DEFAULT_AUDIT_LIMIT = 200;

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
    status: "ok" | "error";
    sessionId?: SessionId;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    await this.record({
      timestamp: new Date().toISOString(),
      category: "http",
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

  listRecent = async (limit = DEFAULT_AUDIT_LIMIT): Promise<AuditEventRecord[]> => {
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

    if (limit <= 0) {
      return records;
    }

    return records.slice(Math.max(0, records.length - limit));
  };

  private mapBusEvent = (
    type: EventType,
  ): { category: AuditEventRecord["category"]; action: string; status: "ok" | "error" } => {
    if (type === EventType.AgentStart) return { category: "agent", action: "agent_start", status: "ok" };
    if (type === EventType.AgentEnd) return { category: "agent", action: "agent_end", status: "ok" };
    if (type === EventType.AgentThought) return { category: "agent", action: "agent_thought", status: "ok" };
    if (type === EventType.ToolStart) return { category: "tool", action: "tool_start", status: "ok" };
    if (type === EventType.ToolEnd) return { category: "tool", action: "tool_end", status: "ok" };
    if (type === EventType.SessionUpdate) return { category: "session", action: "session_update", status: "ok" };
    if (type === EventType.Error) return { category: "error", action: "error", status: "error" };
    if (type === EventType.Message) return { category: "session", action: "message", status: "ok" };
    return { category: "session", action: "event", status: "ok" };
  };
}
