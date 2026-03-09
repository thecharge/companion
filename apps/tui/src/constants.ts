/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function trimYamlValue(raw: string): string {
  const noComment = raw.split("#")[0] ?? "";
  return noComment.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

function resolveTemplate(value: string): string {
  const match = value.match(/^\$\{([^}:]+):-([^}]*)\}$/);
  if (!match) return value;
  const envName = match[1] ?? "";
  const fallback = match[2] ?? "";
  return process.env[envName] ?? fallback;
}

function readServerFromCompanionYaml(): { host?: string; port?: string } {
  try {
    const raw = readFileSync(join(process.cwd(), "companion.yaml"), "utf8");
    const lines = raw.split("\n");
    let inServer = false;
    let host = "";
    let port = "";

    for (const line of lines) {
      if (!inServer) {
        if (/^server:\s*$/.test(line)) inServer = true;
        continue;
      }

      if (/^[^\s#].*:\s*$/.test(line)) break;
      const kv = line.match(/^\s{2}(host|port):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1] ?? "";
      const value = resolveTemplate(trimYamlValue(kv[2] ?? ""));
      if (key === "host") host = value;
      if (key === "port") port = value;
    }

    return { host, port };
  } catch {
    return {};
  }
}

function resolveServerUrl(): string {
  if (process.env.COMPANION_URL?.trim()) {
    return process.env.COMPANION_URL;
  }

  const fromYaml = readServerFromCompanionYaml();
  const hostRaw = process.env.COMPANION_HOST ?? fromYaml.host ?? "localhost";
  const portRaw = process.env.COMPANION_PORT ?? fromYaml.port ?? "3000";
  const host = hostRaw === "0.0.0.0" ? "localhost" : hostRaw;
  return `http://${host}:${portRaw}`;
}

export const SERVER = resolveServerUrl();
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
export const DEFAULT_AUDIT_FETCH_LIMIT = 12;

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
export const BRAILLE_SHIFT_FRAMES = ["\u2801", "\u2803", "\u2807", "\u280f", "\u281f", "\u283f", "\u287f"] as const;
