/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { handleWebSocketEnvelope } from "./ws-event-handler";
import { TaskStatus, type ActiveTask, type Msg } from "../types";

describe("ws event handler", () => {
  test("updates task on agent_start", () => {
    let task: ActiveTask | null = { agent: "", status: TaskStatus.Thinking, since: 0 };
    const messages: Msg[] = [];

    handleWebSocketEnvelope({
      data: JSON.stringify({ type: "agent_start", payload: { agent: "orchestrator" } }),
      pendingAssistantMessageId: null,
      addLogEntry: () => {},
      setTask: (updater: React.SetStateAction<ActiveTask | null>) => {
        task = typeof updater === "function" ? updater(task) : updater;
      },
      setMessages: (updater) => {
        if (typeof updater === "function") {
          updater(messages);
        }
      },
      clearPendingAssistantMessageId: () => {},
    });

    expect(task.agent).toBe("orchestrator");
    expect(task.status).toBe(TaskStatus.Thinking);
  });

  test("replaces pending assistant message on final message event", () => {
    let messages: Msg[] = [{ id: "pending", role: "assistant", content: "partial", streaming: true }];

    handleWebSocketEnvelope({
      data: JSON.stringify({ type: "message", payload: { id: "remote", role: "assistant", content: "final" } }),
      pendingAssistantMessageId: "pending",
      addLogEntry: () => {},
      setTask: () => {},
      setMessages: (updater) => {
        messages = typeof updater === "function" ? updater(messages) : updater;
      },
      clearPendingAssistantMessageId: () => {},
    });

    expect(messages[0]?.content).toBe("final");
    expect(messages[0]?.streaming).toBe(false);
  });
});
