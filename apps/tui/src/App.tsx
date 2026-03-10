/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { useApp, useInput } from "ink";
import React from "react";
import { AppLayout } from "./components/AppLayout";
import { useCompanionAppController } from "./hooks/use-companion-app-controller";
import { Pane } from "./types";
import { handleGlobalInput } from "./utils/global-input-handler";

export const App = () => {
  const { exit } = useApp();
  const controller = useCompanionAppController();

  useInput((ch, key) => {
    handleGlobalInput(ch, key, {
      pane: controller.pane,
      sessions: controller.sessions,
      selectedSessionIndex: controller.selectedSessionIndex,
      setPane: controller.setPane,
      clearReconnectTimer: controller.clearReconnectTimer,
      closeSocket: controller.closeSocket,
      exitApp: exit,
      createSession: () => void controller.createSession(),
      deleteSession: (sessionId) => {
        void controller.removeSession(sessionId);
      },
      openSession: (session) => void controller.openSession(session),
    });
  });

  return (
    <AppLayout
      pane={controller.pane}
      sessions={controller.sessions}
      selectedSessionIndex={controller.selectedSessionIndex}
      setSelectedSessionIndex={controller.setSelectedSessionIndex}
      activeSession={controller.activeSession}
      messages={controller.messages}
      task={controller.task}
      actionLog={controller.actionLog}
      workingDir={controller.workingDir}
      previousWorkingDir={controller.previousWorkingDir}
      setWorkingDir={controller.setWorkingDir}
      setPreviousWorkingDir={controller.setPreviousWorkingDir}
      streaming={controller.streaming}
      wsConnected={controller.wsConnected}
      caps={controller.caps}
      auditEvents={controller.auditEvents}
      statusMsg={controller.statusMsg}
      loaderFrameIndex={controller.loaderFrameIndex}
      addLogEntry={controller.addLogEntry}
      sendMessage={controller.sendMessage}
      sessionRepository={controller.sessionRepository}
      setActiveSession={controller.setActiveSession}
      setSessions={controller.setSessions}
      activeSessionId={controller.activeSession?.id ?? ""}
      abortStreaming={controller.abortStreaming}
    />
  );
};
