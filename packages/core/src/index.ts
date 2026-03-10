/**
 * @companion/core
 *
 * Fundamental types, Blackboard, EventBus, Logger.
 * Zero runtime dependencies outside @companion/config.
 */

import { type IdGenerationStrategy, TimestampRandomIdStrategy } from "./id-generation-strategy";

// ── Branded IDs ───────────────────────────────────────────────

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;

export function asSession(s: string): SessionId {
  return s as SessionId;
}
export function asMessage(s: string): MessageId {
  return s as MessageId;
}

let _seq = 0;
let idStrategy: IdGenerationStrategy = new TimestampRandomIdStrategy();

export function setIdGenerationStrategy(strategy: IdGenerationStrategy): void {
  idStrategy = strategy;
}

export function newId(): string {
  _seq += 1;
  return idStrategy.next(_seq);
}

// ── Result<T,E> ───────────────────────────────────────────────

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ── Session / Message types ───────────────────────────────────

export const SessionStatus = {
  Active: "active",
  Archived: "archived",
  Summarised: "summarised",
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const SessionMode = {
  Local: "local",
  Balanced: "balanced",
  Cloud: "cloud",
} as const;

export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

export const MessageRole = {
  User: "user",
  Assistant: "assistant",
  System: "system",
  Tool: "tool",
} as const;

export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export interface Session {
  id: SessionId;
  title: string;
  status: SessionStatus;
  mode: SessionMode;
  blackboard: string; // JSON BlackboardData
  summary?: string;
  message_count: number;
  version: number; // OCC — incremented on every update
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: MessageId;
  session_id: SessionId;
  role: MessageRole;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
  tokens?: number;
  created_at: Date;
}

// ── BlackboardData ────────────────────────────────────────────

export interface BlackboardDecision {
  round: number;
  action: string;
  target: string;
  reason: string;
}

export interface BlackboardRejection {
  round: number;
  target: string;
  reason: string;
}

export interface BlackboardData {
  goal: string;
  observations: string[];
  decisions: BlackboardDecision[];
  rejections: BlackboardRejection[];
  artifacts: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
}

// ── Blackboard ────────────────────────────────────────────────

export class Blackboard {
  private data: BlackboardData;

  constructor(data?: Partial<BlackboardData>) {
    this.data = {
      goal: data?.goal ?? "",
      observations: data?.observations ?? [],
      decisions: data?.decisions ?? [],
      rejections: data?.rejections ?? [],
      artifacts: data?.artifacts ?? {},
      scratchpad: data?.scratchpad ?? {},
    };
  }

  static fromJSON(json: string): Blackboard {
    try {
      return new Blackboard(JSON.parse(json) as BlackboardData);
    } catch {
      return new Blackboard();
    }
  }

  toJSON(): string {
    return JSON.stringify(this.data);
  }

  get goal(): string {
    return this.data.goal;
  }

  read<K extends keyof BlackboardData>(key: K): BlackboardData[K] {
    return this.data[key];
  }

  viewFor(keys: string[]): Partial<BlackboardData> {
    if (!keys.length) return { ...this.data };
    return Object.fromEntries(
      keys.filter((k) => k in this.data).map((k) => [k, this.data[k as keyof BlackboardData]]),
    ) as Partial<BlackboardData>;
  }

  appendObservation(obs: string): void {
    this.data.observations.push(obs);
  }

  appendDecision(round: number, action: string, target: string, reason: string): void {
    this.data.decisions.push({ round, action, target, reason });
  }

  appendRejection(round: number, target: string, reason: string): void {
    this.data.rejections.push({ round, target, reason });
  }

  setArtifact(key: string, value: unknown): void {
    this.data.artifacts[key] = value;
  }

  setScratchpad(key: string, value: unknown): void {
    this.data.scratchpad[key] = value;
  }

  /**
   * Compact summary for the orchestrator prompt.
   *
   * - Observations: last 5, capped at 400 chars each
   * - Decisions: last 6, reason stripped (dense map)
   * - Rejections: NEVER sliced — orchestrator must never forget dead ends
   * - Artifacts: key names only
   */
  summary(): string {
    const obs = this.data.observations.slice(-5);
    const dec = this.data.decisions.slice(-6);
    const rej = this.data.rejections; // intentionally no slice
    const arts = Object.keys(this.data.artifacts);
    const lines: string[] = [`Goal: ${this.data.goal}`];

    if (obs.length) {
      lines.push(
        `Recent Observations:\n${obs.map((o) => `  - ${o.slice(0, 400)}${o.length > 400 ? "..." : ""}`).join("\n")}`,
      );
    }
    if (dec.length) {
      lines.push(`Path Taken:\n${dec.map((d) => `  [Round ${d.round}] ${d.action} → ${d.target}`).join("\n")}`);
    }
    if (rej.length) {
      const grouped: Record<string, string[]> = {};
      for (const r of rej) {
        grouped[r.target] ??= [];
        grouped[r.target]?.push(`[R${r.round}] ${r.reason}`);
      }
      lines.push("DEAD ENDS — DO NOT RETRY:");
      for (const [target, reasons] of Object.entries(grouped)) {
        lines.push(`  - ${target}: ${reasons.join(" | ")}`);
      }
    }
    if (arts.length) lines.push(`Artifacts: ${arts.join(", ")}`);
    return lines.join("\n\n");
  }
}

// ── EventBus ──────────────────────────────────────────────────

export const EventType = {
  Message: "message",
  ToolStart: "tool_start",
  ToolEnd: "tool_end",
  AgentStart: "agent_start",
  AgentEnd: "agent_end",
  AgentThought: "agent_thought",
  OrchestratorDecision: "orchestrator_decision",
  OrchestratorVerify: "orchestrator_verify",
  SessionUpdate: "session_update",
  Error: "error",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface CompanionEvent {
  type: EventType;
  session_id: SessionId;
  payload: unknown;
  ts: Date;
}

type Handler = (event: CompanionEvent) => void;

class EventBus {
  private handlers: Map<string, Set<Handler>> = new Map();

  on(type: EventType | "*", handler: Handler): () => void {
    const key = type as string;
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key)?.add(handler);
    return () => this.handlers.get(key)?.delete(handler);
  }

  emit(event: CompanionEvent): void {
    const typedHandlers = this.handlers.get(event.type);
    if (typedHandlers) {
      for (const handler of typedHandlers) {
        handler(event);
      }
    }

    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(event);
      }
    }
  }
}

// Singleton bus — server subscribes, agents publish
export const bus = new EventBus();

// ── Logger ────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(private readonly ns: string) {}

  private emit(level: LogLevel, msg: string, meta?: unknown): void {
    const ts = new Date().toISOString();
    const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (meta !== undefined) {
      out(`[${ts}] [${level.toUpperCase()}] [${this.ns}] ${msg}`, meta);
    } else {
      out(`[${ts}] [${level.toUpperCase()}] [${this.ns}] ${msg}`);
    }
  }

  debug(msg: string, meta?: unknown): void {
    this.emit("debug", msg, meta);
  }
  info(msg: string, meta?: unknown): void {
    this.emit("info", msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.emit("warn", msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.emit("error", msg, meta);
  }
}
