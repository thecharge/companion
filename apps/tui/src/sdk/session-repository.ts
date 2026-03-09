/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { DEFAULT_AUDIT_FETCH_LIMIT } from "../constants";
import type { AuditEvent, Caps, Msg, Session } from "../types";
import type { CompanionApiClient } from "./companion-api-client";

export class SessionRepository {
  constructor(private readonly apiClient: CompanionApiClient) {}

  loadSessionsAndCapabilities = async (): Promise<{ sessions: Session[]; caps: Caps; auditEvents: AuditEvent[] }> => {
    const [sessions, caps, auditEvents] = await Promise.all([
      this.apiClient.listSessions(),
      this.apiClient.listCapabilities(),
      this.apiClient.listAuditEvents(DEFAULT_AUDIT_FETCH_LIMIT),
    ]);
    return { sessions, caps, auditEvents };
  };

  createAndLoadSession = async (title: string): Promise<Session> =>
    this.apiClient.createSession({
      title,
      goal: title,
    });

  loadSessionMessages = async (sessionId: string): Promise<Msg[]> => this.apiClient.listMessages(sessionId);

  removeSession = async (sessionId: string): Promise<void> => {
    await this.apiClient.deleteSession(sessionId);
  };

  setSessionMode = async (sessionId: string, mode: Session["mode"]): Promise<void> => {
    await this.apiClient.patchSessionMode(sessionId, mode);
  };
}
