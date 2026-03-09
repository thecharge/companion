/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { Pane, SessionMode, SessionStatus, type Session } from "../types";
import { handleGlobalInput } from "./global-input-handler";

const makeSession = (): Session => ({
  id: "session-1",
  title: "test",
  mode: SessionMode.Local,
  status: SessionStatus.Active,
  message_count: 0,
});

describe("global input handler", () => {
  test("requests create session on n key", () => {
    let called = false;
    handleGlobalInput(
      "n",
      {},
      {
        pane: Pane.Sessions,
        sessions: [makeSession()],
        selectedSessionIndex: 0,
        setPane: () => {},
        clearReconnectTimer: () => {},
        closeSocket: () => {},
        exitApp: () => {},
        createSession: () => {
          called = true;
        },
        deleteSession: () => {},
        openSession: () => {},
      },
    );

    expect(called).toBe(true);
  });

  test("opens selected session on return", () => {
    let opened = false;
    handleGlobalInput(
      "",
      { return: true },
      {
        pane: Pane.Sessions,
        sessions: [makeSession()],
        selectedSessionIndex: 0,
        setPane: () => {},
        clearReconnectTimer: () => {},
        closeSocket: () => {},
        exitApp: () => {},
        createSession: () => {},
        deleteSession: () => {},
        openSession: () => {
          opened = true;
        },
      },
    );

    expect(opened).toBe(true);
  });
});
