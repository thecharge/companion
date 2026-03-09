/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { useApp, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppLayout } from "./components/AppLayout";
import {
  DEFAULT_SESSION_TITLE_PREFIX,
  HARD_TIMEOUT_MS,
  INITIAL_RECONNECT_DELAY_MS,
  LOADER_FRAMES,
  MAX_LOG_ENTRIES,
  MAX_RECONNECT_DELAY_MS,
  POLL_INTERVAL_MS,
  REQUEST_HEADERS,
  SECRET,
  SERVER,
  WS_MESSAGE_TYPE,
  WS_URL,
} from "./constants";
import { CompanionApiClient } from "./sdk/companion-api-client";
import { HttpClient } from "./sdk/http-client";
import { SessionRepository } from "./sdk/session-repository";
import { type ActiveTask, type Caps, type LogEntry, type Msg, Pane, type Session } from "./types";
import { streamSessionMessage } from "./utils/chat-stream";
import { handleGlobalInput } from "./utils/global-input-handler";
import { handleWebSocketEnvelope } from "./utils/ws-event-handler";

const httpClient = new HttpClient({ baseUrl: SERVER, defaultHeaders: { ...REQUEST_HEADERS } });
const companionApiClient = new CompanionApiClient(httpClient);
const sessionRepository = new SessionRepository(companionApiClient);

export const App = () => {
  const { exit } = useApp();
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
  const [statusMsg, setStatusMsg] = useState("");
  const [workingDir, setWorkingDir] = useState(process.cwd());
  const [loaderFrameIndex, setLoaderFrameIndex] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayMsRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const currentSessionIdRef = useRef("");
  const pendingAssistantMessageIdRef = useRef<string | null>(null);

  const addLogEntry = useCallback((text: string) => {
    const timestamp = new Date().toLocaleTimeString("en", { hour12: false });
    setActionLog((previousEntries) => [...previousEntries.slice(-MAX_LOG_ENTRIES), { ts: timestamp, text }]);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) {
      return;
    }
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const loadSessionsAndCapabilities = useCallback(async () => {
    try {
      const loaded = await sessionRepository.loadSessionsAndCapabilities();
      setSessions(loaded.sessions);
      setCaps(loaded.caps);
      setStatusMsg("");
    } catch {
      setStatusMsg(`Cannot reach ${SERVER}`);
    }
  }, []);

  useEffect(() => {
    void loadSessionsAndCapabilities();
    const pollTimer = setInterval(() => void loadSessionsAndCapabilities(), POLL_INTERVAL_MS);
    return () => clearInterval(pollTimer);
  }, [loadSessionsAndCapabilities]);

  useEffect(() => {
    if (!streaming && !task) {
      return;
    }

    const animationTimer = setInterval(() => {
      setLoaderFrameIndex((index) => (index + 1) % LOADER_FRAMES.length);
    }, 200);
    return () => clearInterval(animationTimer);
  }, [streaming, task]);

  const onSocketMessage = useCallback(
    (data: string) => {
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
    [addLogEntry],
  );

  const connectWebSocket = useCallback(
    (session: Session) => {
      clearReconnectTimer();
      wsRef.current?.close();

      const ws = new WebSocket(`${WS_URL}/ws?session=${session.id}&token=${SECRET}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        reconnectDelayMsRef.current = INITIAL_RECONNECT_DELAY_MS;
        addLogEntry("WS connected");
      };
      ws.onmessage = (event) => onSocketMessage(String(event.data));
      ws.onerror = () => setWsConnected(false);
      ws.onclose = () => {
        setWsConnected(false);
        if (currentSessionIdRef.current !== session.id) {
          return;
        }

        const delay = Math.min(reconnectDelayMsRef.current, MAX_RECONNECT_DELAY_MS);
        reconnectDelayMsRef.current = delay * 2;
        addLogEntry(`WS retry ${delay / 1000}s`);
        reconnectTimerRef.current = setTimeout(() => connectWebSocket(session), delay);
      };
    },
    [addLogEntry, clearReconnectTimer, onSocketMessage],
  );

  const openSession = useCallback(
    async (session: Session) => {
      currentSessionIdRef.current = session.id;
      reconnectDelayMsRef.current = INITIAL_RECONNECT_DELAY_MS;
      setActiveSession(session);
      setPane(Pane.Chat);
      setMessages([]);
      setActionLog([]);
      setTask(null);

      const history = await sessionRepository.loadSessionMessages(session.id);
      setMessages(history);
      connectWebSocket(session);
    },
    [connectWebSocket],
  );

  const createSession = useCallback(async () => {
    const now = new Date().toLocaleTimeString("en", { hour12: false });
    const title = `${DEFAULT_SESSION_TITLE_PREFIX} ${now}`;
    const session = await sessionRepository.createAndLoadSession(title);
    await loadSessionsAndCapabilities();
    await openSession(session);
  }, [loadSessionsAndCapabilities, openSession]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeSession || streaming) {
        return;
      }

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
          apiClient: companionApiClient,
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
    [activeSession, addLogEntry, streaming, workingDir],
  );

  useInput((ch, key) => {
    handleGlobalInput(ch, key, {
      pane,
      sessions,
      selectedSessionIndex,
      setPane,
      clearReconnectTimer,
      closeSocket: () => wsRef.current?.close(),
      exitApp: exit,
      createSession: () => void createSession(),
      deleteSession: (sessionId) => {
        void sessionRepository.removeSession(sessionId).then(loadSessionsAndCapabilities);
      },
      openSession: (session) => void openSession(session),
    });
  });

  return (
    <AppLayout
      pane={pane}
      sessions={sessions}
      selectedSessionIndex={selectedSessionIndex}
      setSelectedSessionIndex={setSelectedSessionIndex}
      activeSession={activeSession}
      messages={messages}
      task={task}
      actionLog={actionLog}
      workingDir={workingDir}
      setWorkingDir={setWorkingDir}
      streaming={streaming}
      wsConnected={wsConnected}
      caps={caps}
      statusMsg={statusMsg}
      loaderFrameIndex={loaderFrameIndex}
      addLogEntry={addLogEntry}
      sendMessage={sendMessage}
      sessionRepository={sessionRepository}
      setActiveSession={setActiveSession}
      setSessions={setSessions}
      activeSessionId={activeSession?.id ?? ""}
      abortStreaming={() => {
        if (wsRef.current?.readyState === WebSocket.OPEN && currentSessionIdRef.current) {
          wsRef.current.send(JSON.stringify({ type: WS_MESSAGE_TYPE.Cancel, session_id: currentSessionIdRef.current }));
        }

        abortCtrlRef.current?.abort();
        abortCtrlRef.current = null;
        setStreaming(false);
        addLogEntry("cancelled");
      }}
    />
  );
};
