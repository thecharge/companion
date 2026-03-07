#!/usr/bin/env bun
/**
 * @companion/tui
 *
 * Terminal UI built with Ink + React.
 * Run: bun run apps/tui/src/index.tsx
 *
 * Features:
 * - Virtual scroll (↑/↓ when input unfocused)
 * - AbortController with 120s timeout on sendMessage
 * - Esc key force-unlocks a hung streaming state
 * - sync_state on WS reconnect clears dead spinners
 * - Exponential backoff WS reconnect (1s → 30s)
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
// ink-text-input is a simple peer dep of ink — no further deps
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ink-text-input has types in its own package
import TextInput from "ink-text-input";

const SERVER = process.env["COMPANION_URL"] ?? "http://localhost:3000";
const WS_URL = SERVER.replace(/^http/, "ws");
const SECRET = process.env["COMPANION_SECRET"] ?? "";
const HEADERS = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const VISIBLE = 12;

// ── API ───────────────────────────────────────────────────────

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────

interface Session {
  id: string;
  title: string;
  mode: string;
  status: string;
  message_count: number;
  summary?: string;
}

interface Msg {
  id: string;
  role: string;
  content: string;
  streaming?: boolean;
}

interface Caps {
  agents: Array<{ name: string; description: string; model: string }>;
  tools: Array<{ name: string; description: string; source: string }>;
  skills: Array<{ name: string; description: string }>;
}

interface ActiveTask {
  agent: string;
  tool?: string;
  thought?: string;
  status: "thinking" | "running_tool" | "synthesizing";
  since: number;
}

interface LogEntry {
  ts: string;
  text: string;
}

type Pane = "sessions" | "chat" | "capabilities";

// ── SessionList ───────────────────────────────────────────────

function SessionList({
  sessions,
  idx,
  active,
  onSelect,
  onNew,
  onDel,
}: {
  sessions: Session[];
  idx: number;
  active: boolean;
  onSelect: (i: number) => void;
  onNew: () => void;
  onDel: () => void;
}) {
  useInput((_ch, key) => {
    if (!active) return;
    if (key.upArrow) onSelect(Math.max(0, idx - 1));
    if (key.downArrow) onSelect(Math.min(sessions.length - 1, idx + 1));
  });

  const modeColor = (m: string) => (m === "local" ? "green" : m === "cloud" ? "blue" : "yellow");

  return (
    <Box flexDirection="column" width={34} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        {" "}
        Sessions {active ? "[n=new d=del ↑↓]" : ""}
      </Text>
      {sessions.length === 0 && <Text color="gray"> (none) — press n</Text>}
      {sessions.map((s, i) => (
        <Box key={s.id}>
          <Text color={i === idx ? "black" : "white"} backgroundColor={i === idx ? "cyan" : undefined}>
            {" "}
            <Text color={modeColor(s.mode)}>●</Text> {s.title.slice(0, 23).padEnd(23)}
            {String(s.message_count).padStart(3)}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray"> n=new d=del Enter=open</Text>
      </Box>
    </Box>
  );
}

// ── ActiveTaskBox ─────────────────────────────────────────────

function ActiveTaskBox({ task }: { task: ActiveTask }) {
  const elapsed = Math.floor((Date.now() - task.since) / 1000);
  const label = { thinking: "thinking", running_tool: "running tool", synthesizing: "synthesizing" }[task.status];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          ⚙ {task.agent} — {label}…
        </Text>
        <Text color="gray">{elapsed}s</Text>
      </Box>
      {task.tool && (
        <Text color="cyan">
          {" "}
          ↳ tool: <Text bold>{task.tool}</Text>
        </Text>
      )}
      {task.thought && (
        <Text color="gray" dimColor wrap="wrap">
          {" "}
          ❝ {task.thought.slice(0, 110)}
        </Text>
      )}
    </Box>
  );
}

// ── ActionLog ─────────────────────────────────────────────────

function ActionLog({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {entries.slice(-6).map((e, i) => (
        <Text key={i} color="gray" dimColor>
          {e.ts} {e.text}
        </Text>
      ))}
    </Box>
  );
}

// ── ChatPane ──────────────────────────────────────────────────

function ChatPane({
  session,
  messages,
  task,
  log: actionLog,
  streaming,
  active,
  wsConnected,
  onSend,
  onModeChange,
  onAbort,
}: {
  session?: Session;
  messages: Msg[];
  task: ActiveTask | null;
  log: LogEntry[];
  streaming: boolean;
  active: boolean;
  wsConnected: boolean;
  onSend: (t: string) => void;
  onModeChange: (m: string) => void;
  onAbort: () => void;
}) {
  const [input, setInput] = useState("");
  const [focused, setFocus] = useState(false);
  const [scrollOffset, setScroll] = useState(0);

  // Snap to bottom on new messages or session change
  useEffect(() => {
    setScroll(0);
  }, [messages.length, session?.id]);

  useInput((ch, key) => {
    if (!active) return;

    if (key.escape) {
      setFocus(false);
      if (streaming) onAbort();
      return;
    }

    if (ch === "/" && !focused) {
      setFocus(true);
      return;
    }

    if (!focused) {
      if (key.upArrow) setScroll((s) => Math.min(s + 1, Math.max(0, messages.length - VISIBLE)));
      if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
      if (key.return && messages.length > 0) setScroll(0); // jump to bottom
    }

    if (ch === "1") onModeChange("local");
    if (ch === "2") onModeChange("balanced");
    if (ch === "3") onModeChange("cloud");
  });

  const modeColor = { local: "green", balanced: "yellow", cloud: "blue" }[session?.mode ?? "local"] ?? "gray";
  const modeLabel = { local: "⚡ LOCAL", balanced: "⚖ BAL", cloud: "☁ CLOUD" }[session?.mode ?? "local"] ?? "";

  // Virtual scroll window — newest at bottom
  const visibleMessages = [...messages]
    .reverse()
    .slice(scrollOffset, scrollOffset + VISIBLE)
    .reverse();

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      {!session ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color="gray">Select or create a session</Text>
        </Box>
      ) : (
        <>
          {/* Header */}
          <Box justifyContent="space-between">
            <Text bold color="cyan">
              {" "}
              {session.title.slice(0, 28)}
            </Text>
            <Box>
              <Text color={modeColor} bold>
                {" "}
                {modeLabel}
              </Text>
              {streaming && <Text color="yellow"> ▌</Text>}
              {!wsConnected && <Text color="red"> ⚠WS</Text>}
              <Text color="gray"> [1/2/3]</Text>
            </Box>
          </Box>

          {session.summary && (
            <Text color="gray" dimColor wrap="wrap">
              {" "}
              ↻ {session.summary.slice(0, 120)}
            </Text>
          )}

          {/* Scroll indicator */}
          {scrollOffset > 0 && (
            <Text color="gray" dimColor>
              {" "}
              ↑ {scrollOffset} older — ↓ to scroll back ↩ jump to bottom
            </Text>
          )}

          {/* Messages */}
          <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
            {visibleMessages.map((m) => (
              <Box key={m.id} flexDirection="column" marginBottom={1}>
                <Text bold color={m.role === "user" ? "green" : "white"}>
                  {m.role === "user" ? "You" : "Companion"}
                  {m.streaming ? " ▌" : ""}
                </Text>
                <Text wrap="wrap">{m.content || (m.streaming ? "▌" : "")}</Text>
              </Box>
            ))}
          </Box>

          {/* Active task */}
          {task && <ActiveTaskBox task={task} />}

          {/* Action log */}
          <ActionLog entries={actionLog} />

          {/* Input */}
          <Box borderStyle="round" borderColor={focused ? "green" : streaming ? "yellow" : "gray"} marginTop={1}>
            {streaming ? (
              <Text color="yellow"> working… (Esc to abort)</Text>
            ) : focused ? (
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={(t: string) => {
                  if (t.trim()) onSend(t.trim());
                  setInput("");
                  setFocus(false);
                }}
                placeholder="Message…"
              />
            ) : (
              <Text color="gray"> / to type ↑↓ scroll 1/2/3 mode q quit</Text>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

// ── CapabilitiesPane ──────────────────────────────────────────

function CapabilitiesPane({ caps, active }: { caps: Caps | null; active: boolean }) {
  const [tab, setTab] = useState<"agents" | "tools" | "skills">("agents");
  useInput((ch) => {
    if (!active) return;
    if (ch === "1") setTab("agents");
    if (ch === "2") setTab("tools");
    if (ch === "3") setTab("skills");
  });
  return (
    <Box flexDirection="column" width={36} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        {" "}
        Capabilities {active ? "[1/2/3]" : ""}
      </Text>
      {!caps && <Text color="gray"> Loading…</Text>}
      {caps && (
        <>
          <Box>
            <Text color={tab === "agents" ? "cyan" : "gray"}> Agents({caps.agents.length})</Text>
            <Text color={tab === "tools" ? "cyan" : "gray"}> Tools({caps.tools.length})</Text>
            <Text color={tab === "skills" ? "cyan" : "gray"}> Skills({caps.skills.length})</Text>
          </Box>
          {tab === "agents" &&
            caps.agents.map((a) => (
              <Box key={a.name} flexDirection="column" marginBottom={1} marginLeft={1}>
                <Text bold>
                  {a.name} <Text color="gray">({a.model})</Text>
                </Text>
                <Text color="gray" wrap="wrap">
                  {" "}
                  {a.description.slice(0, 100)}
                </Text>
              </Box>
            ))}
          {tab === "tools" &&
            caps.tools.slice(0, 15).map((t) => (
              <Box key={t.name} flexDirection="column" marginBottom={1} marginLeft={1}>
                <Text bold>{t.name}</Text>
                <Text color="gray" wrap="wrap">
                  {" "}
                  {t.description.slice(0, 80)}
                </Text>
              </Box>
            ))}
          {tab === "skills" &&
            (caps.skills.length === 0 ? (
              <Text color="gray"> No skills — add .skill.yaml to ./skills/</Text>
            ) : (
              caps.skills.map((s) => (
                <Box key={s.name} flexDirection="column" marginBottom={1} marginLeft={1}>
                  <Text bold>{s.name}</Text>
                  <Text color="gray" wrap="wrap">
                    {" "}
                    {s.description}
                  </Text>
                </Box>
              ))
            ))}
        </>
      )}
    </Box>
  );
}

// ── App ───────────────────────────────────────────────────────

function App() {
  const { exit } = useApp();
  const [pane, setPane] = useState<Pane>("sessions");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [idx, setIdx] = useState(0);
  const [active, setActive] = useState<Session | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [task, setTask] = useState<ActiveTask | null>(null);
  const [actionLog, setActionLog] = useState<LogEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [wsConnected, setWsConn] = useState(false);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const reconnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnDelay = useRef(1000);
  const currentSidRef = useRef("");

  const addLog = useCallback((text: string) => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setActionLog((prev) => [...prev.slice(-40), { ts, text }]);
  }, []);

  const abortStream = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setStreaming(false);
    addLog("aborted");
  }, [addLog]);

  // Poll sessions + capabilities every 5s
  useEffect(() => {
    const load = async () => {
      try {
        const [{ sessions: ss }, c] = await Promise.all([
          apiFetch<{ sessions: Session[] }>("GET", "/sessions"),
          apiFetch<Caps>("GET", "/capabilities"),
        ]);
        setSessions(ss);
        setCaps(c);
        setStatusMsg("");
      } catch (e) {
        setStatusMsg(`Cannot reach ${SERVER}`);
        void e;
      }
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  // WebSocket
  const connectWS = useCallback(
    (session: Session) => {
      if (reconnTimer.current) {
        clearTimeout(reconnTimer.current);
        reconnTimer.current = null;
      }
      wsRef.current?.close();

      const ws = new WebSocket(`${WS_URL}/ws?session=${session.id}&token=${SECRET}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConn(true);
        reconnDelay.current = 1000;
        addLog("WS connected");
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const e = JSON.parse(ev.data) as { type: string; payload?: unknown };
          const p = (e.payload ?? {}) as Record<string, unknown>;

          switch (e.type) {
            case "sync_state":
              // Authoritative state from server — clears dead spinners on reconnect
              if (p && Object.keys(p).length > 0) {
                setTask({
                  agent: String(p["agent"] ?? ""),
                  tool: p["tool"] as string | undefined,
                  thought: p["thought"] as string | undefined,
                  status: (p["status"] as ActiveTask["status"]) ?? "thinking",
                  since: Date.now(),
                });
              } else {
                setTask(null);
              }
              break;

            case "agent_start":
              setTask({ agent: String(p["agent"] ?? ""), status: "thinking", since: Date.now() });
              addLog(`→ ${p["agent"] as string}`);
              break;

            case "agent_thought":
              setTask((prev) => (prev ? { ...prev, thought: String(p["text"] ?? "") } : null));
              break;

            case "tool_start":
              setTask((prev) => (prev ? { ...prev, tool: String(p["tool"] ?? ""), status: "running_tool" } : null));
              addLog(`  ⚙ ${p["tool"] as string}`);
              break;

            case "tool_end":
              setTask((prev) => (prev ? { ...prev, tool: undefined, status: "thinking" } : null));
              if (p["error"]) addLog(`  ✗ ${p["tool"] as string}: ${String(p["error"]).slice(0, 50)}`);
              else addLog(`  ✓ ${p["tool"] as string} (${p["duration_ms"] as number}ms)`);
              break;

            case "orchestrator_decision":
              addLog(`◆ [R${p["round"] as number}] ${p["action"] as string} → ${String(p["target"] ?? "")}`);
              break;

            case "agent_end":
              setTask(null);
              addLog(`← done (${p["stopped_reason"] as string})`);
              break;

            case "message": {
              const m = e.payload as Msg;
              setMessages((prev) => [...prev.filter((x) => x.id !== m.id), { ...m, streaming: false }]);
              setTask(null);
              break;
            }

            case "error":
              addLog(`ERR: ${String(p["error"]).slice(0, 70)}`);
              setTask(null);
              break;
          }
        } catch (err) {
          addLog(`WS parse: ${err}`);
        }
      };

      ws.onclose = () => {
        setWsConn(false);
        if (currentSidRef.current === session.id) {
          const delay = Math.min(reconnDelay.current, 30_000);
          reconnDelay.current = delay * 2;
          addLog(`WS closed, retry in ${delay / 1000}s`);
          reconnTimer.current = setTimeout(() => connectWS(session), delay);
        }
      };

      ws.onerror = () => setWsConn(false);
    },
    [addLog],
  );

  const openSession = useCallback(
    async (s: Session) => {
      currentSidRef.current = s.id;
      reconnDelay.current = 1000;
      setActive(s);
      setPane("chat");
      setMessages([]);
      setActionLog([]);
      setTask(null);
      const { messages: ms } = await apiFetch<{ messages: Msg[] }>("GET", `/sessions/${s.id}/messages`);
      setMessages(ms);
      connectWS(s);
    },
    [connectWS],
  );

  const newSession = useCallback(async () => {
    const title = `Chat ${new Date().toLocaleTimeString("en", { hour12: false })}`;
    const { session } = await apiFetch<{ session: Session }>("POST", "/sessions", { title, goal: title });
    const { sessions: ss } = await apiFetch<{ sessions: Session[] }>("GET", "/sessions");
    setSessions(ss);
    await openSession(session);
  }, [openSession]);

  const delSession = useCallback(async () => {
    const s = sessions[idx];
    if (!s) return;
    await apiFetch("DELETE", `/sessions/${s.id}`);
    if (active?.id === s.id) {
      currentSidRef.current = "";
      wsRef.current?.close();
      setActive(undefined);
      setMessages([]);
      setTask(null);
    }
    const { sessions: ss } = await apiFetch<{ sessions: Session[] }>("GET", "/sessions");
    setSessions(ss);
  }, [sessions, idx, active]);

  const changeMode = useCallback(
    async (mode: string) => {
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
      // 120s hard timeout — prevents permanent lockout on silent failures
      const hardTimeout = setTimeout(() => {
        ctrl.abort();
        addLog("timeout (120s)");
      }, 120_000);

      const botId = crypto.randomUUID();
      const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content };
      const botMsg: Msg = { id: botId, role: "assistant", content: "", streaming: true };
      setMessages((prev) => [...prev, userMsg, botMsg]);
      addLog(`→ sent`);

      try {
        const res = await fetch(`${SERVER}/sessions/${active.id}/messages`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ content, stream: true }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string };
              if (ev.type === "text" && ev.text) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === botId ? { ...m, content: m.content + (ev.text ?? "") } : m)),
                );
              }
              if (ev.type === "error") addLog(`err: ${ev.error ?? ""}`);
            } catch {
              /* partial SSE line — next read completes it */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setMessages((prev) =>
            prev.map((m) => (m.id === botId ? { ...m, content: `[Error: ${e}]`, streaming: false } : m)),
          );
          addLog(`error: ${e}`);
        }
      } finally {
        // Always runs — no permanent lockout possible
        clearTimeout(hardTimeout);
        abortCtrlRef.current = null;
        setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, streaming: false } : m)));
        setStreaming(false);
      }
    },
    [active, streaming, addLog],
  );

  const paneOrder: Pane[] = ["sessions", "chat", "capabilities"];

  useInput((ch, key) => {
    if (key.tab) {
      setPane((p) => {
        const i = paneOrder.indexOf(p);
        return paneOrder[(i + 1) % paneOrder.length]!;
      });
    }
    if (pane === "sessions") {
      if (ch === "n") void newSession();
      if (ch === "d") void delSession();
      if (key.return && sessions[idx]) void openSession(sessions[idx]!);
    }
    if (ch === "q" && pane === "sessions") {
      if (reconnTimer.current) clearTimeout(reconnTimer.current);
      wsRef.current?.close();
      exit();
    }
  });

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 40}>
      {/* Title bar */}
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color="cyan">
          ⚡ Companion
        </Text>
        <Text color="gray">Tab=switch /=input ↑↓=scroll q=quit</Text>
        {statusMsg && <Text color="red"> {statusMsg}</Text>}
      </Box>

      {/* Main layout */}
      <Box flexGrow={1}>
        <SessionList
          sessions={sessions}
          idx={idx}
          active={pane === "sessions"}
          onSelect={(i) => {
            setIdx(i);
            if (sessions[i]) void openSession(sessions[i]!);
          }}
          onNew={() => void newSession()}
          onDel={() => void delSession()}
        />
        <ChatPane
          session={active}
          messages={messages}
          task={task}
          log={actionLog}
          streaming={streaming}
          active={pane === "chat"}
          wsConnected={wsConnected}
          onSend={(t) => void sendMessage(t)}
          onModeChange={(m) => void changeMode(m)}
          onAbort={abortStream}
        />
        <CapabilitiesPane caps={caps} active={pane === "capabilities"} />
      </Box>
    </Box>
  );
}

render(<App />);
