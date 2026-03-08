/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import { CapabilitiesPane } from "./components/CapabilitiesPane";
import { ChatPane } from "./components/ChatPane";
import { SessionList } from "./components/SessionList";
import {
  HARD_TIMEOUT_MS,
  MAX_LOG_ENTRIES,
  MAX_RECONNECT_DELAY_MS,
  POLL_INTERVAL_MS,
  REQUEST_HEADERS,
  SECRET,
  SERVER,
  WS_URL,
} from "./constants";
import {
  type ActiveTask,
  type Caps,
  type LogEntry,
  type Msg,
  Pane,
  type Session,
  SessionMode,
  TaskStatus,
} from "./types";

interface SyncStatePayload {
  agent?: string;
  tool?: string;
  thought?: string;
  status?: ActiveTask["status"];
}

export function App() {
  const { exit } = useApp();
  const [pane, setPane] = useState<Pane>(Pane.Sessions);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [idx, setIdx] = useState(0);
  const [active, setActive] = useState<Session | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [task, setTask] = useState<ActiveTask | null>(null);
  const [actionLog, setActionLog] = useState<LogEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [workingDir, setWorkingDir] = useState(process.cwd());

  const wsRef = useRef<WebSocket | null>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const currentSessionRef = useRef("");

  const addLog = useCallback((text: string) => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setActionLog((prev) => [...prev.slice(-MAX_LOG_ENTRIES), { ts, text }]);
  }, []);

  const abortStream = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && currentSessionRef.current) {
      wsRef.current.send(JSON.stringify({ type: "cancel", session_id: currentSessionRef.current }));
    }
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setStreaming(false);
    addLog("cancelled");
  }, [addLog]);

  useEffect(() => {
    const load = async () => {
      try {
        const [{ sessions: allSessions }, allCaps] = await Promise.all([
          apiFetch<{ sessions: Session[] }>("GET", "/sessions"),
          apiFetch<Caps>("GET", "/capabilities"),
        ]);
        setSessions(allSessions);
        setCaps(allCaps);
        setStatusMsg("");
      } catch {
        setStatusMsg(`Cannot reach ${SERVER}`);
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const connectWS = useCallback(
    (session: Session) => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();

      const ws = new WebSocket(`${WS_URL}/ws?session=${session.id}&token=${SECRET}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        reconnectDelayRef.current = 1000;
        addLog("WS connected");
      };

      ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(String(event.data)) as { type: string; payload?: unknown };
          const payload = (envelope.payload ?? {}) as Record<string, unknown>;

          switch (envelope.type) {
            case "sync_state": {
              const sync = payload as SyncStatePayload;
              if (Object.keys(sync).length === 0) {
                setTask(null);
                break;
              }
              setTask({
                agent: String(sync.agent ?? ""),
                tool: sync.tool,
                thought: sync.thought,
                status: sync.status ?? TaskStatus.Thinking,
                since: Date.now(),
              });
              break;
            }
            case "agent_start":
              setTask({ agent: String(payload["agent"] ?? ""), status: TaskStatus.Thinking, since: Date.now() });
              addLog(`start ${String(payload["agent"] ?? "")}`);
              break;
            case "agent_thought":
              setTask((prev) => (prev ? { ...prev, thought: String(payload["text"] ?? "") } : null));
              break;
            case "tool_start":
              setTask((prev) =>
                prev
                  ? { ...prev, tool: String(payload["tool"] ?? ""), status: TaskStatus.RunningTool }
                  : null,
              );
              addLog(`tool ${String(payload["tool"] ?? "")}`);
              break;
            case "tool_end":
              setTask((prev) => (prev ? { ...prev, tool: undefined, status: TaskStatus.Thinking } : null));
              if (payload["error"]) {
                addLog(`tool error ${String(payload["tool"] ?? "")}`);
              } else {
                addLog(`tool ok ${String(payload["tool"] ?? "")}`);
              }
              break;
            case "agent_end":
              setTask(null);
              addLog(`end ${String(payload["stopped_reason"] ?? "")}`);
              break;
            case "message": {
              const message = envelope.payload as Msg;
              setMessages((prev) => [...prev.filter((m) => m.id !== message.id), { ...message, streaming: false }]);
              setTask(null);
              break;
            }
            case "error":
              addLog(`error ${String(payload["error"] ?? "")}`.slice(0, 80));
              setTask(null);
              break;
            default:
              break;
          }
        } catch (error) {
          addLog(`WS parse ${String(error)}`);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (currentSessionRef.current === session.id) {
          const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY_MS);
          reconnectDelayRef.current = delay * 2;
          addLog(`WS retry ${delay / 1000}s`);
          reconnectTimerRef.current = setTimeout(() => connectWS(session), delay);
        }
      };

      ws.onerror = () => setWsConnected(false);
    },
    [addLog],
  );

  const openSession = useCallback(
    async (session: Session) => {
      currentSessionRef.current = session.id;
      reconnectDelayRef.current = 1000;
      setActive(session);
      setPane(Pane.Chat);
      setMessages([]);
      setActionLog([]);
      setTask(null);
      const { messages: history } = await apiFetch<{ messages: Msg[] }>("GET", `/sessions/${session.id}/messages`);
      setMessages(history);
      connectWS(session);
    },
    [connectWS],
  );

  const newSession = useCallback(async () => {
    const title = `Chat ${new Date().toLocaleTimeString("en", { hour12: false })}`;
    const { session } = await apiFetch<{ session: Session }>("POST", "/sessions", { title, goal: title });
    const { sessions: allSessions } = await apiFetch<{ sessions: Session[] }>("GET", "/sessions");
    setSessions(allSessions);
    await openSession(session);
  }, [openSession]);

  const deleteSession = useCallback(async () => {
    const current = sessions[idx];
    if (!current) return;

    await apiFetch("DELETE", `/sessions/${current.id}`);
    if (active?.id === current.id) {
      currentSessionRef.current = "";
      wsRef.current?.close();
      setActive(undefined);
      setMessages([]);
      setTask(null);
    }

    const { sessions: allSessions } = await apiFetch<{ sessions: Session[] }>("GET", "/sessions");
    setSessions(allSessions);
  }, [active?.id, idx, sessions]);

  const changeMode = useCallback(
    async (mode: Session["mode"]) => {
      if (!active) return;
      await apiFetch("PATCH", `/sessions/${active.id}`, { mode });
      setActive((prev) => (prev ? { ...prev, mode } : prev));
      setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, mode } : s)));
    },
    [active],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!active || streaming) return;
      setStreaming(true);

      const ctrl = new AbortController();
      abortCtrlRef.current = ctrl;

      const hardTimeout = setTimeout(() => {
        ctrl.abort();
        addLog("timeout 120s");
      }, HARD_TIMEOUT_MS);

      const assistantId = crypto.randomUUID();
      const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content };
      const assistantMsg: Msg = { id: assistantId, role: "assistant", content: "", streaming: true };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      addLog("sent");

      try {
        const res = await fetch(`${SERVER}/sessions/${active.id}/messages`, {
          method: "POST",
          headers: REQUEST_HEADERS,
          body: JSON.stringify({ content, working_dir: workingDir, stream: true }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string };
              if (event.type === "text") {
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + (event.text ?? "") } : m)),
                );
              }
              if (event.type === "error") {
                addLog(`stream error ${event.error ?? ""}`.slice(0, 80));
              }
            } catch {
              // Partial SSE payloads are completed in subsequent reads.
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: `[Error: ${error}]`, streaming: false } : m)),
          );
          addLog(`error ${String(error)}`.slice(0, 80));
        }
      } finally {
        clearTimeout(hardTimeout);
        abortCtrlRef.current = null;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
        setStreaming(false);
      }
    },
    [active, addLog, streaming, workingDir],
  );

  const paneOrder: Pane[] = [Pane.Sessions, Pane.Chat, Pane.Capabilities];

  useInput((ch, key) => {
    if (key.tab) {
      setPane((prev) => {
        const i = paneOrder.indexOf(prev);
        return paneOrder[(i + 1) % paneOrder.length] ?? Pane.Sessions;
      });
    }

    if (pane === Pane.Sessions) {
      if (ch === "n") void newSession();
      if (ch === "d") void deleteSession();
      if (key.return) {
        const selected = sessions[idx];
        if (selected) void openSession(selected);
      }
    }

    if (ch === "q" && pane === Pane.Sessions) {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      exit();
    }
  });

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      abortCtrlRef.current?.abort();
    };
  }, []);

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 40}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color="cyan">
          Companion (by Radoslav Sandov)
        </Text>
        <Text color="gray">Tab switch / type up/down scroll /wd &lt;path&gt; q quit</Text>
        {statusMsg && <Text color="red"> {statusMsg}</Text>}
      </Box>

      <Box flexGrow={1}>
        <SessionList
          sessions={sessions}
          idx={idx}
          active={pane === Pane.Sessions}
          onSelect={(i) => {
            setIdx(i);
          }}
        />

        <ChatPane
          session={active}
          messages={messages}
          task={task}
          actionLog={actionLog}
          workingDir={workingDir}
          streaming={streaming}
          active={pane === Pane.Chat}
          wsConnected={wsConnected}
          onSend={(text) => {
            if (text === "/wd") {
              addLog(`working_dir ${workingDir}`);
              return;
            }
            if (text.startsWith("/wd ")) {
              const next = text.slice(4).trim();
              if (next) {
                setWorkingDir(next);
                addLog(`working_dir set ${next}`);
              }
              return;
            }
            void sendMessage(text);
          }}
          onModeChange={(mode) => void changeMode(mode)}
          onAbort={abortStream}
        />

        <CapabilitiesPane caps={caps} active={pane === Pane.Capabilities} />
      </Box>
    </Box>
  );
}
