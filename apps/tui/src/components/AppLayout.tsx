/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Box, Text } from "ink";
import type React from "react";
import { LOADER_FRAMES } from "../constants";
import type { SessionRepository } from "../sdk/session-repository";
import { type ActiveTask, type Caps, type LogEntry, type Msg, Pane, type Session } from "../types";
import { CapabilitiesPane } from "./CapabilitiesPane";
import { ChatPane } from "./ChatPane";
import { SessionList } from "./SessionList";

interface AppLayoutProps {
  pane: Pane;
  sessions: Session[];
  selectedSessionIndex: number;
  setSelectedSessionIndex: (index: number) => void;
  activeSession?: Session;
  messages: Msg[];
  task: ActiveTask | null;
  actionLog: LogEntry[];
  workingDir: string;
  previousWorkingDir: string;
  setWorkingDir: (path: string) => void;
  setPreviousWorkingDir: (path: string) => void;
  streaming: boolean;
  wsConnected: boolean;
  caps: Caps | null;
  statusMsg: string;
  loaderFrameIndex: number;
  addLogEntry: (text: string) => void;
  sendMessage: (text: string) => Promise<void>;
  sessionRepository: SessionRepository;
  setActiveSession: React.Dispatch<React.SetStateAction<Session | undefined>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  activeSessionId: string;
  abortStreaming: () => void;
}

const getTaskStageLabel = (task: ActiveTask): string => {
  if (task.status === "running_tool") {
    return "tool";
  }

  if (task.status === "synthesizing") {
    return "synth";
  }

  return "thinking";
};

const getThinkingLabel = (task: ActiveTask | null): string => {
  if (!task) {
    return "thinking";
  }

  const stage = getTaskStageLabel(task);
  const withTool = task.tool ? ` ${stage}:${task.tool}` : ` ${stage}`;
  return `agent:${task.agent}${withTool}`;
};

export const AppLayout = ({
  pane,
  sessions,
  selectedSessionIndex,
  setSelectedSessionIndex,
  activeSession,
  messages,
  task,
  actionLog,
  workingDir,
  previousWorkingDir,
  setWorkingDir,
  setPreviousWorkingDir,
  streaming,
  wsConnected,
  caps,
  statusMsg,
  loaderFrameIndex,
  addLogEntry,
  sendMessage,
  sessionRepository,
  setActiveSession,
  setSessions,
  activeSessionId,
  abortStreaming,
}: AppLayoutProps) => (
  <Box flexDirection="column" height={process.stdout.rows ?? 40}>
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold color="cyan">
        Companion (by Radoslav Sandov)
      </Text>
      <Text color="gray">Tab switch / type up/down scroll /wd &lt;path&gt; q quit</Text>
      {(streaming || task) && (
        <Text color="yellow">
          {getThinkingLabel(task)}
          {LOADER_FRAMES[loaderFrameIndex]}
        </Text>
      )}
      {statusMsg && <Text color="red"> {statusMsg}</Text>}
    </Box>

    <Box flexGrow={1}>
      <SessionList
        sessions={sessions}
        idx={selectedSessionIndex}
        active={pane === Pane.Sessions}
        onSelect={setSelectedSessionIndex}
      />
      <ChatPane
        session={activeSession}
        messages={messages}
        task={task}
        actionLog={actionLog}
        workingDir={workingDir}
        streaming={streaming}
        active={pane === Pane.Chat}
        wsConnected={wsConnected}
        onSend={(text) => {
          const normalized = text.startsWith("/") ? text : `/${text}`;

          if (normalized === "/wd") {
            addLogEntry(`working_dir ${workingDir}`);
            return;
          }

          if (normalized.startsWith("/wd ")) {
            const rawPath = normalized.slice(4).trim();
            const nextWorkingDir = rawPath === "-" ? previousWorkingDir : resolve(rawPath || workingDir);
            if (!nextWorkingDir) {
              addLogEntry("working_dir unchanged");
              return;
            }

            if (!existsSync(nextWorkingDir)) {
              addLogEntry(`working_dir not found ${nextWorkingDir}`);
              return;
            }

            if (!statSync(nextWorkingDir).isDirectory()) {
              addLogEntry(`working_dir not a directory ${nextWorkingDir}`);
              return;
            }

            setPreviousWorkingDir(workingDir);
            setWorkingDir(nextWorkingDir);
            addLogEntry(`working_dir set ${nextWorkingDir}`);
            return;
          }

          void sendMessage(text);
        }}
        onModeChange={(mode) => {
          if (!activeSession) {
            return;
          }

          void sessionRepository.setSessionMode(activeSession.id, mode).then(() => {
            setActiveSession((existingSession) => (existingSession ? { ...existingSession, mode } : existingSession));
            setSessions((existingSessions) =>
              existingSessions.map((session) => (session.id === activeSessionId ? { ...session, mode } : session)),
            );
          });
        }}
        onAbort={abortStreaming}
      />
      <CapabilitiesPane caps={caps} active={pane === Pane.Capabilities} />
    </Box>
  </Box>
);
