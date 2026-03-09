/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type React from "react";
import { WS_MESSAGE_TYPE } from "../constants";
import { type Msg, type SyncStatePayload, TaskStatus, type WsEnvelope } from "../types";

interface HandlerParams {
  data: string;
  pendingAssistantMessageId: string | null;
  addLogEntry: (text: string) => void;
  setTask: React.Dispatch<React.SetStateAction<import("../types").ActiveTask | null>>;
  setMessages: React.Dispatch<React.SetStateAction<Msg[]>>;
  clearPendingAssistantMessageId: () => void;
}

export const handleWebSocketEnvelope = ({
  data,
  pendingAssistantMessageId,
  addLogEntry,
  setTask,
  setMessages,
  clearPendingAssistantMessageId,
}: HandlerParams): void => {
  try {
    const envelope = JSON.parse(data) as WsEnvelope;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    if (envelope.type === WS_MESSAGE_TYPE.SyncState) {
      const syncState = payload as SyncStatePayload;
      if (Object.keys(syncState).length === 0) {
        setTask(null);
        return;
      }

      setTask({
        agent: String(syncState.agent ?? ""),
        tool: syncState.tool,
        thought: syncState.thought,
        status: syncState.status ?? TaskStatus.Thinking,
        since: Date.now(),
      });
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.AgentStart) {
      setTask({ agent: String(payload.agent ?? ""), status: TaskStatus.Thinking, since: Date.now() });
      addLogEntry(`start ${String(payload.agent ?? "")}`);
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.AgentThought) {
      const thought = String(payload.text ?? "");
      setTask((previousTask) =>
        previousTask
          ? { ...previousTask, thought }
          : {
              agent: String(payload.agent ?? "assistant"),
              thought,
              status: TaskStatus.Thinking,
              since: Date.now(),
            },
      );
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.ToolStart) {
      setTask((previousTask) =>
        previousTask
          ? { ...previousTask, tool: String(payload.tool ?? ""), status: TaskStatus.RunningTool }
          : previousTask,
      );
      addLogEntry(`tool ${String(payload.tool ?? "")}`);
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.ToolEnd) {
      setTask((previousTask) =>
        previousTask ? { ...previousTask, tool: undefined, status: TaskStatus.Thinking } : previousTask,
      );
      const toolName = String(payload.tool ?? "");
      addLogEntry(payload.error ? `tool error ${toolName}` : `tool ok ${toolName}`);
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.AgentEnd) {
      setTask(null);
      addLogEntry(`end ${String(payload.stopped_reason ?? "")}`);
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.Message) {
      const incomingMessage = envelope.payload as Msg;
      setMessages((existingMessages) => {
        if (!pendingAssistantMessageId) {
          return [
            ...existingMessages.filter((m) => m.id !== incomingMessage.id),
            { ...incomingMessage, streaming: false },
          ];
        }

        return existingMessages.map((message) =>
          message.id === pendingAssistantMessageId
            ? { ...message, content: incomingMessage.content, streaming: false }
            : message,
        );
      });
      clearPendingAssistantMessageId();
      setTask(null);
      return;
    }

    if (envelope.type === WS_MESSAGE_TYPE.Error) {
      addLogEntry(`error ${String(payload.error ?? "")}`.slice(0, 80));
      setTask(null);
    }
  } catch (error) {
    addLogEntry(`WS parse ${String(error)}`);
  }
};
