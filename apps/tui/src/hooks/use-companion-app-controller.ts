/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  BRAILLE_SHIFT_FRAMES,
  DEFAULT_SESSION_TITLE_PREFIX,
  HARD_TIMEOUT_MS,
  MAX_LOG_ENTRIES,
  POLL_INTERVAL_MS,
  SERVER,
} from "../constants";
import { createTuiRuntime } from "../factories/tui-runtime-factory";
import { SessionWebSocketFacade } from "../services/session-ws-facade";
import { type ActiveTask, type AuditEvent, type Caps, type LogEntry, type Msg, Pane, type Session } from "../types";
import { streamSessionMessage } from "../utils/chat-stream";
import { handleWebSocketEnvelope } from "../utils/ws-event-handler";

const fastSignature = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export interface CompanionAppController {
  pane: Pane;
  sessions: Session[];
  selectedSessionIndex: number;
  activeSession?: Session;
  messages: Msg[];
  task: ActiveTask | null;
  actionLog: LogEntry[];
  streaming: boolean;
  wsConnected: boolean;
  caps: Caps | null;
  auditEvents: AuditEvent[];
  statusMsg: string;
  workingDir: string;
  previousWorkingDir: string;
  loaderFrameIndex: number;
  sessionRepository: ReturnType<typeof createTuiRuntime>["sessionRepository"];
  setPane: React.Dispatch<React.SetStateAction<Pane>>;
  setSelectedSessionIndex: (index: number) => void;
  setWorkingDir: (path: string) => void;
  setPreviousWorkingDir: (path: string) => void;
  setActiveSession: React.Dispatch<React.SetStateAction<Session | undefined>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  addLogEntry: (text: string) => void;
  createSession: () => Promise<void>;
  openSession: (session: Session) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  abortStreaming: () => void;
  closeSocket: () => void;
  clearReconnectTimer: () => void;
}

export const useCompanionAppController = (): CompanionAppController => {
  const runtime = useMemo(() => createTuiRuntime(), []);
  const { apiClient, sessionRepository } = runtime;

  const [pane, setPane] = useState<Pane>(Pane.Sessions);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const [activeSession, setActiveSession] = useState<Session | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [task, setTask] = useState<ActiveTask | null>(null);
  const [actionLog, setActionLog] = useState<LogEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [statusMsg, setStatusMsg] = useState("");
  const [workingDir, setWorkingDir] = useState(process.cwd());
  const [previousWorkingDir, setPreviousWorkingDir] = useState(process.cwd());
  const [loaderFrameIndex, setLoaderFrameIndex] = useState(0);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const pendingAssistantMessageIdRef = useRef<string | null>(null);
  const lastSessionsSigRef = useRef("");
  const lastCapsSigRef = useRef("");
  const lastAuditSigRef = useRef("");

  const addLogEntry = useCallback((text: string) => {
    const timestamp = new Date().toLocaleTimeString("en", { hour12: false });
    setActionLog((previousEntries) => [...previousEntries.slice(-MAX_LOG_ENTRIES), { ts: timestamp, text }]);
  }, []);

  const wsFacadeRef = useRef<SessionWebSocketFacade | null>(null);
  if (!wsFacadeRef.current) {
    wsFacadeRef.current = new SessionWebSocketFacade({
      onConnected: () => {
        setWsConnected(true);
        addLogEntry("WS connected");
      },
      onDisconnected: () => setWsConnected(false),
      onRetry: (delayMs) => addLogEntry(`WS retry ${delayMs / 1000}s`),
      onMessage: (data) => {
        handleWebSocketEnvelope({
          data,
          pendingAssistantMessageId: pendingAssistantMessageIdRef.current,
          addLogEntry,
          setTask,
          setMessages,
          clearPendingAssistantMessageId: () => {
            pendingAssistantMessageIdRef.current = null;
          },
        });
      },
    });
  }

  const clearReconnectTimer = useCallback(() => {
    // facade owns reconnect timer; close() clears timer without disconnecting active consumers.
    // connect() re-establishes the same session when needed.
  }, []);

  const loadSessionsAndCapabilities = useCallback(async () => {
    try {
      const loaded = await sessionRepository.loadSessionsAndCapabilities();

      const sessionsSig = fastSignature(loaded.sessions.map((s) => [s.id, s.title, s.mode, s.status, s.message_count]));
      if (sessionsSig !== lastSessionsSigRef.current) {
        lastSessionsSigRef.current = sessionsSig;
        setSessions(loaded.sessions);
      }

      const capsSig = fastSignature(loaded.caps);
      if (capsSig !== lastCapsSigRef.current) {
        lastCapsSigRef.current = capsSig;
        setCaps(loaded.caps);
      }

      const auditSig = fastSignature(
        loaded.auditEvents.map((e) => [
          e.event_id ?? "",
          e.timestamp,
          e.category,
          e.action,
          e.status,
          e.session_id ?? "",
        ]),
      );
      if (auditSig !== lastAuditSigRef.current) {
        lastAuditSigRef.current = auditSig;
        setAuditEvents(loaded.auditEvents);
      }

      setStatusMsg("");
    } catch {
      setStatusMsg(`Cannot reach ${SERVER}`);
    }
  }, [sessionRepository]);

  useEffect(() => {
    void loadSessionsAndCapabilities();

    // Lower polling pressure while user inspects capabilities to avoid visible jitter.
    const intervalMs = pane === Pane.Capabilities ? POLL_INTERVAL_MS * 3 : POLL_INTERVAL_MS;
    const pollTimer = setInterval(() => void loadSessionsAndCapabilities(), intervalMs);
    return () => clearInterval(pollTimer);
  }, [loadSessionsAndCapabilities, pane]);

  useEffect(() => {
    if (!streaming && !task) return;
    const timer = setInterval(() => {
      setLoaderFrameIndex((index) => (index + 1) % BRAILLE_SHIFT_FRAMES.length);
    }, 200);
    return () => clearInterval(timer);
  }, [streaming, task]);

  useEffect(
    () => () => {
      wsFacadeRef.current?.cancelCurrentSession();
      abortCtrlRef.current?.abort();
      wsFacadeRef.current?.close();
    },
    [],
  );

  const openSession = useCallback(
    async (session: Session) => {
      setActiveSession(session);
      setPane(Pane.Chat);
      setMessages([]);
      setActionLog([]);
      setTask(null);

      const history = await sessionRepository.loadSessionMessages(session.id);
      setMessages(history);
      wsFacadeRef.current?.connect(session.id);
    },
    [sessionRepository],
  );

  const createSession = useCallback(async () => {
    const now = new Date().toLocaleTimeString("en", { hour12: false });
    const title = `${DEFAULT_SESSION_TITLE_PREFIX} ${now}`;
    const session = await sessionRepository.createAndLoadSession(title);
    await loadSessionsAndCapabilities();
    await openSession(session);
  }, [loadSessionsAndCapabilities, openSession, sessionRepository]);

  const removeSession = useCallback(
    async (sessionId: string) => {
      await sessionRepository.removeSession(sessionId);
      await loadSessionsAndCapabilities();
    },
    [loadSessionsAndCapabilities, sessionRepository],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeSession || streaming) return;

      setStreaming(true);
      const abortController = new AbortController();
      abortCtrlRef.current = abortController;

      const timeout = setTimeout(() => {
        abortController.abort();
        addLogEntry("timeout 120s");
      }, HARD_TIMEOUT_MS);

      const pendingAssistantMessageId = crypto.randomUUID();
      pendingAssistantMessageIdRef.current = pendingAssistantMessageId;
      setMessages((previousMessages) => [
        ...previousMessages,
        { id: crypto.randomUUID(), role: "user", content },
        { id: pendingAssistantMessageId, role: "assistant", content: "", streaming: true },
      ]);

      try {
        await streamSessionMessage({
          apiClient,
          sessionId: activeSession.id,
          content,
          workingDir,
          abortSignal: abortController.signal,
          pendingAssistantMessageId,
          setMessages,
          addLogEntry,
        });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setMessages((existingMessages) =>
            existingMessages.map((message) =>
              message.id === pendingAssistantMessageId
                ? { ...message, content: `[Error: ${String(error)}]`, streaming: false }
                : message,
            ),
          );
          pendingAssistantMessageIdRef.current = null;
        }
      } finally {
        clearTimeout(timeout);
        abortCtrlRef.current = null;
        setStreaming(false);
        setMessages((existingMessages) =>
          existingMessages.map((message) =>
            message.id === pendingAssistantMessageId ? { ...message, streaming: false } : message,
          ),
        );
      }
    },
    [activeSession, addLogEntry, apiClient, streaming, workingDir],
  );

  const abortStreaming = useCallback(() => {
    wsFacadeRef.current?.cancelCurrentSession();
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setStreaming(false);
    addLogEntry("cancelled");
  }, [addLogEntry]);

  const closeSocket = useCallback(() => {
    wsFacadeRef.current?.close();
  }, []);

  return {
    pane,
    sessions,
    selectedSessionIndex,
    activeSession,
    messages,
    task,
    actionLog,
    streaming,
    wsConnected,
    caps,
    auditEvents,
    statusMsg,
    workingDir,
    previousWorkingDir,
    loaderFrameIndex,
    sessionRepository,
    setPane,
    setSelectedSessionIndex,
    setWorkingDir,
    setPreviousWorkingDir,
    setActiveSession,
    setSessions,
    addLogEntry,
    createSession,
    openSession,
    removeSession,
    sendMessage,
    abortStreaming,
    closeSocket,
    clearReconnectTimer,
  };
};
