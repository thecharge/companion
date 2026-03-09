/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { AuditEvent, Caps, Msg, Session } from "../types";
import type { HttpClient } from "./http-client";

export interface CreateSessionInput {
  title: string;
  goal: string;
}

export interface SendMessageInput {
  content: string;
  working_dir: string;
  stream: boolean;
}

export class CompanionApiClient {
  constructor(private readonly httpClient: HttpClient) {}

  listSessions = async (): Promise<Session[]> => {
    const response = await this.httpClient.request<{ sessions: Session[] }>("GET", "/sessions");
    return response.sessions;
  };

  listCapabilities = async (): Promise<Caps> => this.httpClient.request<Caps>("GET", "/capabilities");

  listAuditEvents = async (limit: number): Promise<AuditEvent[]> => {
    const response = await this.httpClient.request<{ events: AuditEvent[] }>("GET", `/audit/events?limit=${limit}`);
    return response.events;
  };

  createSession = async (input: CreateSessionInput): Promise<Session> => {
    const response = await this.httpClient.request<{ session: Session }>("POST", "/sessions", input);
    return response.session;
  };

  deleteSession = async (sessionId: string): Promise<void> => {
    await this.httpClient.request<{ ok: boolean }>("DELETE", `/sessions/${sessionId}`);
  };

  patchSessionMode = async (sessionId: string, mode: Session["mode"]): Promise<void> => {
    await this.httpClient.request<{ ok: boolean }>("PATCH", `/sessions/${sessionId}`, { mode });
  };

  listMessages = async (sessionId: string): Promise<Msg[]> => {
    const response = await this.httpClient.request<{ messages: Msg[] }>("GET", `/sessions/${sessionId}/messages`);
    return response.messages;
  };

  streamMessage = async (sessionId: string, payload: SendMessageInput, signal: AbortSignal): Promise<Response> => {
    const response = await fetch(`${this.httpClient.getBaseUrl()}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: this.httpClient.getDefaultHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} /sessions/${sessionId}/messages`);
    }

    return response;
  };
}
