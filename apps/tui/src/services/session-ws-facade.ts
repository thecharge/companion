/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { INITIAL_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS, SECRET, WS_MESSAGE_TYPE, WS_URL } from "../constants";

interface SessionWebSocketFacadeParams {
  onMessage: (data: string) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onRetry: (delayMs: number) => void;
}

export class SessionWebSocketFacade {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private socketGeneration = 0;
  private activeSessionId = "";

  constructor(private readonly params: SessionWebSocketFacadeParams) {}

  connect(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.clearReconnectTimer();
    this.socketGeneration += 1;
    const generation = this.socketGeneration;

    this.socket?.close();
    this.socket = new WebSocket(`${WS_URL}/ws?session=${sessionId}&token=${SECRET}`);

    this.socket.onopen = () => {
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.params.onConnected();
    };

    this.socket.onmessage = (event) => {
      this.params.onMessage(String(event.data));
    };

    this.socket.onerror = () => {
      this.params.onDisconnected();
    };

    this.socket.onclose = () => {
      if (generation !== this.socketGeneration) return;
      this.params.onDisconnected();
      if (!this.activeSessionId || this.activeSessionId !== sessionId) return;

      const delay = Math.min(this.reconnectDelayMs, MAX_RECONNECT_DELAY_MS);
      this.reconnectDelayMs = delay * 2;
      this.params.onRetry(delay);

      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(sessionId), delay);
    };
  }

  cancelCurrentSession(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.activeSessionId) return;

    this.socket.send(
      JSON.stringify({
        type: WS_MESSAGE_TYPE.Cancel,
        session_id: this.activeSessionId,
      }),
    );
  }

  close(): void {
    this.clearReconnectTimer();
    this.activeSessionId = "";
    this.socket?.close();
    this.socket = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
