/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

export const SessionMode = {
  Local: "local",
  Balanced: "balanced",
  Cloud: "cloud",
} as const;

export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

export const SessionStatus = {
  Active: "active",
  Archived: "archived",
  Summarised: "summarised",
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const TaskStatus = {
  Thinking: "thinking",
  RunningTool: "running_tool",
  Synthesizing: "synthesizing",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const Pane = {
  Sessions: "sessions",
  Chat: "chat",
  Capabilities: "capabilities",
} as const;

export type Pane = (typeof Pane)[keyof typeof Pane];

export interface Session {
  id: string;
  title: string;
  mode: SessionMode;
  status: SessionStatus;
  message_count: number;
  summary?: string;
}

export interface Msg {
  id: string;
  role: string;
  content: string;
  streaming?: boolean;
}

export interface Caps {
  agents: Array<{ name: string; description: string; model: string }>;
  tools: Array<{ name: string; description: string; source: string }>;
  skills: Array<{ name: string; description: string }>;
}

export interface AuditEvent {
  event_id?: string;
  timestamp: string;
  category: "http" | "agent" | "tool" | "session" | "error";
  action: string;
  status: "ok" | "error";
  session_id?: string;
  actor_id?: string;
  actor_type?: string;
  source_ip?: string;
  request_id?: string;
  http_method?: string;
  http_path?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}

export interface ActiveTask {
  agent: string;
  tool?: string;
  thought?: string;
  status: TaskStatus;
  since: number;
}

export interface LogEntry {
  ts: string;
  text: string;
}

export interface WsEnvelope {
  type: string;
  payload?: unknown;
}

export interface SyncStatePayload {
  agent?: string;
  tool?: string;
  thought?: string;
  status?: ActiveTask["status"];
}
