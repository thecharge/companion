/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { MessageRole, type SessionId, asMessage, newId } from "@companion/core";
import type { DB } from "@companion/db";

export class SessionChatRepository {
  constructor(private readonly db: DB) {}

  listMessages = async (sessionId: SessionId, limit: number) => this.db.messages.list(sessionId, { limit });

  addAssistantMessage = async (sessionId: SessionId, content: string) =>
    this.db.messages.add({
      id: asMessage(newId()),
      session_id: sessionId,
      role: MessageRole.Assistant,
      content,
    });

  incrementMessageCount = async (sessionId: SessionId): Promise<void> => {
    await this.db.sessions.incrementMessageCount(sessionId);
  };

  updateSessionSummary = async (sessionId: SessionId, summary: string): Promise<void> => {
    await this.db.sessions.update(sessionId, { summary });
  };

  updateSessionBlackboard = async (
    sessionId: SessionId,
    expectedVersion: number,
    blackboard: string,
  ): Promise<void> => {
    await this.db.sessions.update(sessionId, {
      blackboard,
      expected_version: expectedVersion,
    });
  };
}
