/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { type CompanionEvent, EventType, type SessionId, bus } from "@companion/core";
import { Logger } from "@companion/core";

const log = new Logger("server.websocket");

export interface ActiveTaskState {
  agent: string;
  tool?: string;
  thought?: string;
  status: "thinking" | "running_tool" | "synthesizing";
}

type WSClient = import("bun").ServerWebSocket<{ session_id: string }>;

export class SessionWebSocketHub {
  private readonly subscribersBySessionId = new Map<string, Set<WSClient>>();
  private readonly activeTasksBySessionId = new Map<string, ActiveTaskState>();

  constructor(private readonly activeCancelsBySessionId: Map<SessionId, AbortController>) {
    this.bindBusEvents();
  }

  subscribeClient = (ws: WSClient, sessionId: string): void => {
    const existingSubscribers = this.subscribersBySessionId.get(sessionId);
    if (!existingSubscribers) {
      this.subscribersBySessionId.set(sessionId, new Set([ws]));
      ws.data.session_id = sessionId;
      return;
    }

    existingSubscribers.add(ws);
    ws.data.session_id = sessionId;
  };

  unsubscribeClient = (ws: WSClient): void => {
    const currentSessionId = ws.data.session_id;
    if (!currentSessionId) {
      return;
    }

    this.subscribersBySessionId.get(currentSessionId)?.delete(ws);
  };

  getActiveTask = (sessionId: string): ActiveTaskState | null => this.activeTasksBySessionId.get(sessionId) ?? null;

  handleInboundMessage = (ws: WSClient, rawMessage: string | Buffer): void => {
    try {
      const parsed = JSON.parse(String(rawMessage)) as { type: string; session_id?: string };
      if (parsed.type === "subscribe" && parsed.session_id) {
        this.unsubscribeClient(ws);
        this.subscribeClient(ws, parsed.session_id);
        ws.send(JSON.stringify({ type: "subscribed", session_id: parsed.session_id }));
        ws.send(this.createSyncStatePayload(parsed.session_id));
        return;
      }

      if (parsed.type !== "cancel" || !parsed.session_id) {
        return;
      }

      const abortController = this.activeCancelsBySessionId.get(parsed.session_id as SessionId);
      if (!abortController) {
        return;
      }

      abortController.abort();
      this.activeCancelsBySessionId.delete(parsed.session_id as SessionId);
      ws.send(JSON.stringify({ type: "cancelled", session_id: parsed.session_id }));
      bus.emit({
        type: EventType.Error,
        session_id: parsed.session_id as SessionId,
        ts: new Date(),
        payload: { error: "cancelled" },
      });
    } catch (error) {
      log.debug(`WS message parse error: ${error}`);
    }
  };

  createConnectedPayload = (sessionId: string): string => JSON.stringify({ type: "connected", session_id: sessionId });

  createSyncStatePayload = (sessionId: string): string =>
    JSON.stringify({
      type: "sync_state",
      session_id: sessionId,
      payload: this.getActiveTask(sessionId),
      ts: new Date().toISOString(),
    });

  private bindBusEvents = (): void => {
    bus.on(EventType.AgentStart, (event) => {
      const payload = event.payload as Record<string, unknown>;
      this.activeTasksBySessionId.set(event.session_id, {
        agent: String(payload.agent ?? ""),
        status: "thinking",
      });
    });

    bus.on(EventType.AgentThought, (event) => {
      const activeTask = this.activeTasksBySessionId.get(event.session_id);
      if (!activeTask) {
        return;
      }

      activeTask.thought = String((event.payload as Record<string, unknown>).text ?? "");
    });

    bus.on(EventType.ToolStart, (event) => {
      const activeTask = this.activeTasksBySessionId.get(event.session_id);
      if (!activeTask) {
        return;
      }

      activeTask.tool = String((event.payload as Record<string, unknown>).tool ?? "");
      activeTask.status = "running_tool";
    });

    bus.on(EventType.ToolEnd, (event) => {
      const activeTask = this.activeTasksBySessionId.get(event.session_id);
      if (!activeTask) {
        return;
      }

      activeTask.tool = undefined;
      activeTask.status = "thinking";
    });

    bus.on(EventType.AgentEnd, (event) => {
      this.activeTasksBySessionId.delete(event.session_id);
    });

    bus.on(EventType.Message, (event) => {
      this.activeTasksBySessionId.delete(event.session_id);
    });

    bus.on("*", (event) => {
      this.broadcastEvent(event.session_id, event);
    });
  };

  private broadcastEvent = (sessionId: string, event: CompanionEvent): void => {
    const subscribers = this.subscribersBySessionId.get(sessionId);
    if (!subscribers) {
      return;
    }

    const payload = JSON.stringify({ ...event, ts: event.ts.toISOString() });
    for (const subscriber of subscribers) {
      try {
        subscriber.send(payload);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  };
}
