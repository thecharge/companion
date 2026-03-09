/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Pane, type Session } from "../types";
import type React from "react";

interface InputHandlerParams {
  pane: Pane;
  sessions: Session[];
  selectedSessionIndex: number;
  setPane: React.Dispatch<React.SetStateAction<Pane>>;
  clearReconnectTimer: () => void;
  closeSocket: () => void;
  exitApp: () => void;
  createSession: () => void;
  deleteSession: (sessionId: string) => void;
  openSession: (session: Session) => void;
}

export const handleGlobalInput = (
  ch: string,
  key: { tab?: boolean; return?: boolean },
  params: InputHandlerParams,
): void => {
  if (key.tab) {
    const paneOrder: Pane[] = [Pane.Sessions, Pane.Chat, Pane.Capabilities];
    params.setPane(
      (previousPane) => paneOrder[(paneOrder.indexOf(previousPane) + 1) % paneOrder.length] ?? Pane.Sessions,
    );
  }

  if (params.pane === Pane.Sessions && ch === "q") {
    params.clearReconnectTimer();
    params.closeSocket();
    params.exitApp();
  }

  if (params.pane !== Pane.Sessions) {
    return;
  }

  if (ch === "n") {
    params.createSession();
  }

  if (ch === "d") {
    const current = params.sessions[params.selectedSessionIndex];
    if (!current) {
      return;
    }

    params.deleteSession(current.id);
  }

  if (!key.return) {
    return;
  }

  const selected = params.sessions[params.selectedSessionIndex];
  if (selected) {
    params.openSession(selected);
  }
};
