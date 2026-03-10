/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useInput } from "ink";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore ink-text-input publishes its own types
import TextInput from "ink-text-input";
import React, { useEffect, useRef, useState } from "react";
import { BRAILLE_SHIFT_FRAMES, VISIBLE_MESSAGES } from "../constants";
import {
  type ActiveTask,
  type AuditEvent,
  type LogEntry,
  type Msg,
  type Session,
  SessionMode,
  TaskStatus,
} from "../types";

function modeColor(mode: Session["mode"]): string {
  if (mode === SessionMode.Local) return "green";
  if (mode === SessionMode.Balanced) return "yellow";
  if (mode === SessionMode.Cloud) return "blue";
  return "gray";
}

function modeLabel(mode: Session["mode"]): string {
  if (mode === SessionMode.Local) return "LOCAL";
  if (mode === SessionMode.Balanced) return "BALANCED";
  if (mode === SessionMode.Cloud) return "CLOUD";
  return "UNKNOWN";
}

function taskLabel(status: ActiveTask["status"]): string {
  if (status === TaskStatus.RunningTool) return "running tool";
  if (status === TaskStatus.Synthesizing) return "synthesizing";
  return "reasoning";
}

function ActiveTaskBox({ task }: { task: ActiveTask }) {
  const elapsed = Math.floor((Date.now() - task.since) / 1000);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          AGENT {task.agent} - {taskLabel(task.status)}
        </Text>
        <Text color="gray">{elapsed}s</Text>
      </Box>
      {task.tool && (
        <Text color="cyan">
          tool: <Text bold>{task.tool}</Text>
        </Text>
      )}
      {task.thought && (
        <Text color="gray" dimColor wrap="wrap">
          thought: {task.thought.slice(0, 110)}
        </Text>
      )}
    </Box>
  );
}

function ActionLog({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {entries.slice(-6).map((entry) => (
        <Text key={`${entry.ts}-${entry.text}`} color="gray" dimColor>
          {entry.ts} {entry.text}
        </Text>
      ))}
    </Box>
  );
}

function AuditTail({ events }: { events: AuditEvent[] }) {
  if (!events.length) return null;
  const recent = events.slice(-3).reverse();
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        audit tail
      </Text>
      {recent.map((event) => (
        <Text key={`${event.timestamp}:${event.action}`} color={event.status === "error" ? "red" : "gray"} dimColor>
          {new Date(event.timestamp).toLocaleTimeString("en", { hour12: false })} {event.category}:{event.action}
        </Text>
      ))}
    </Box>
  );
}

export function ChatPane({
  session,
  messages,
  task,
  actionLog,
  workingDir,
  streaming,
  active,
  wsConnected,
  auditEvents,
  loaderFrameIndex,
  onSend,
  onModeChange,
  onAbort,
}: {
  session?: Session;
  messages: Msg[];
  task: ActiveTask | null;
  actionLog: LogEntry[];
  workingDir: string;
  streaming: boolean;
  active: boolean;
  wsConnected: boolean;
  auditEvents: AuditEvent[];
  loaderFrameIndex: number;
  onSend: (t: string) => void;
  onModeChange: (m: Session["mode"]) => void;
  onAbort: () => void;
}) {
  const [input, setInput] = useState("");
  const [focused, setFocus] = useState(false);
  const [scrollOffset, setScroll] = useState(0);
  const prevSessionId = useRef<string | undefined>();
  const prevMessageCount = useRef(0);

  useEffect(() => {
    if (prevSessionId.current !== session?.id || prevMessageCount.current !== messages.length) {
      setScroll(0);
      prevSessionId.current = session?.id;
      prevMessageCount.current = messages.length;
    }
  }, [messages.length, session?.id]);

  useInput((ch, key) => {
    if (!active) return;

    if (key.escape) {
      setFocus(false);
      if (streaming) onAbort();
      return;
    }

    if (ch === "/" && !focused) {
      setFocus(true);
      setInput("/");
      return;
    }

    if (key.return && !focused) {
      setFocus(true);
      return;
    }

    if (!focused) {
      if (key.upArrow) setScroll((s) => Math.min(s + 1, Math.max(0, messages.length - VISIBLE_MESSAGES)));
      if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
      if (key.return && messages.length > 0) setScroll(0);
    }

    if (ch === "1") onModeChange(SessionMode.Local);
    if (ch === "2") onModeChange(SessionMode.Balanced);
    if (ch === "3") onModeChange(SessionMode.Cloud);
  });

  const mode = session?.mode ?? SessionMode.Local;
  const visibleMessages = [...messages]
    .reverse()
    .slice(scrollOffset, scrollOffset + VISIBLE_MESSAGES)
    .reverse();

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      {!session ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color="gray">Select or create a session</Text>
        </Box>
      ) : (
        <>
          <Box justifyContent="space-between">
            <Text bold color="cyan">
              {" "}
              {session.title.slice(0, 28)}
            </Text>
            <Box>
              <Text color={modeColor(mode)} bold>
                {" "}
                {modeLabel(mode)}
              </Text>
              {streaming && <Text color="yellow"> [stream]</Text>}
              {!wsConnected && <Text color="red"> WS!</Text>}
              <Text color="gray"> [1/2/3]</Text>
            </Box>
          </Box>

          {session.summary && (
            <Text color="gray" dimColor wrap="wrap">
              summary: {session.summary.slice(0, 120)}
            </Text>
          )}

          <Text color="gray" dimColor wrap="truncate-end">
            working_dir: {workingDir}
          </Text>

          {scrollOffset > 0 && (
            <Text color="gray" dimColor>
              older +{scrollOffset} - down to newest, enter to jump
            </Text>
          )}

          <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
            {visibleMessages.map((msg) => (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                <Text bold color={msg.role === "user" ? "green" : "white"}>
                  {msg.role === "user" ? "You" : "Companion"}
                  {msg.streaming ? " [stream]" : ""}
                </Text>
                <Text wrap="wrap">{msg.content || (msg.streaming ? "[streaming]" : "")}</Text>
              </Box>
            ))}
          </Box>

          {task && <ActiveTaskBox task={task} />}
          <ActionLog entries={actionLog} />
          <AuditTail events={auditEvents} />

          <Box borderStyle="round" borderColor={focused ? "green" : streaming ? "yellow" : "gray"} marginTop={1}>
            {streaming ? (
              <Text color="yellow">
                processing {BRAILLE_SHIFT_FRAMES[loaderFrameIndex % BRAILLE_SHIFT_FRAMES.length]} (Esc abort)
              </Text>
            ) : focused ? (
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={(text: string) => {
                  if (text.trim()) onSend(text.trim());
                  setInput("");
                  setFocus(false);
                }}
                placeholder="Message..."
              />
            ) : (
              <Text color="gray"> Enter or / to type, up/down scroll, 1/2/3 mode, /wd &lt;path&gt;</Text>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
