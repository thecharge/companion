/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { CompanionApiClient } from "../sdk/companion-api-client";
import type { Msg } from "../types";
import type React from "react";

interface StreamParams {
  apiClient: CompanionApiClient;
  sessionId: string;
  content: string;
  workingDir: string;
  abortSignal: AbortSignal;
  pendingAssistantMessageId: string;
  setMessages: React.Dispatch<React.SetStateAction<Msg[]>>;
  addLogEntry: (text: string) => void;
}

export const streamSessionMessage = async ({
  apiClient,
  sessionId,
  content,
  workingDir,
  abortSignal,
  pendingAssistantMessageId,
  setMessages,
  addLogEntry,
}: StreamParams): Promise<void> => {
  const response = await apiClient.streamMessage(
    sessionId,
    { content, working_dir: workingDir, stream: true },
    abortSignal,
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Streaming reader unavailable");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      try {
        const event = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string };
        if (event.type === "text") {
          setMessages((existingMessages) =>
            existingMessages.map((message) =>
              message.id === pendingAssistantMessageId
                ? { ...message, content: `${message.content}${event.text ?? ""}` }
                : message,
            ),
          );
        }

        if (event.type === "error") {
          addLogEntry(`stream error ${event.error ?? ""}`.slice(0, 80));
        }
      } catch {
        // Partial SSE payloads are completed in subsequent reads.
      }
    }
  }
};
