/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { Pane, type Session, SessionMode, SessionStatus } from "../types";
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
        abortStreaming: () => {},
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
        abortStreaming: () => {},
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

  test("quits from any pane and aborts active streaming", () => {
    let aborted = false;
    let closed = false;
    let exited = false;

    handleGlobalInput(
      "q",
      {},
      {
        pane: Pane.Chat,
        sessions: [makeSession()],
        selectedSessionIndex: 0,
        setPane: () => {},
        clearReconnectTimer: () => {},
        closeSocket: () => {
          closed = true;
        },
        abortStreaming: () => {
          aborted = true;
        },
        exitApp: () => {
          exited = true;
        },
        createSession: () => {},
        deleteSession: () => {},
        openSession: () => {},
      },
    );

    expect(aborted).toBe(true);
    expect(closed).toBe(true);
    expect(exited).toBe(true);
  });

  test("reopens selected session on r from any pane", () => {
    let opened = false;
    let switchedToChat = false;

    handleGlobalInput(
      "r",
      {},
      {
        pane: Pane.Capabilities,
        sessions: [makeSession()],
        selectedSessionIndex: 0,
        setPane: (next) => {
          if (typeof next === "function") {
            const resolved = next(Pane.Sessions);
            switchedToChat = resolved === Pane.Chat;
          } else {
            switchedToChat = next === Pane.Chat;
          }
        },
        clearReconnectTimer: () => {},
        closeSocket: () => {},
        abortStreaming: () => {},
        exitApp: () => {},
        createSession: () => {},
        deleteSession: () => {},
        openSession: () => {
          opened = true;
        },
      },
    );

    expect(opened).toBe(true);
    expect(switchedToChat).toBe(true);
  });
});
