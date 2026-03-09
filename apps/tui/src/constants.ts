/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

export const SERVER = process.env.COMPANION_URL ?? "http://localhost:3000";
export const WS_URL = SERVER.replace(/^http/, "ws");
export const SECRET = process.env.COMPANION_SECRET ?? "";
export const VISIBLE_MESSAGES = 12;
export const DEFAULT_SESSION_TITLE_PREFIX = "Chat";

export const REQUEST_HEADERS = {
  Authorization: `Bearer ${SECRET}`,
  "Content-Type": "application/json",
} as const;

export const HARD_TIMEOUT_MS = 120_000;
export const POLL_INTERVAL_MS = 5000;
export const MAX_LOG_ENTRIES = 40;
export const MAX_RECONNECT_DELAY_MS = 30_000;
export const INITIAL_RECONNECT_DELAY_MS = 1000;

export const WS_MESSAGE_TYPE = {
  SyncState: "sync_state",
  AgentStart: "agent_start",
  AgentThought: "agent_thought",
  ToolStart: "tool_start",
  ToolEnd: "tool_end",
  AgentEnd: "agent_end",
  Message: "message",
  Error: "error",
  Cancel: "cancel",
} as const;

export const LOADER_FRAMES = [".", "..", "...", "...."] as const;
