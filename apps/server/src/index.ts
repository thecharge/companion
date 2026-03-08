/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { SessionProcessor } from "@companion/agents";
import { ConfigStore, loadConfig } from "@companion/config";
import {
  Blackboard,
  type CompanionEvent,
  EventType,
  Logger,
  MessageRole,
  type SessionId,
  asMessage,
  asSession,
  bus,
  newId,
} from "@companion/core";
import { ConcurrencyError, createDB } from "@companion/db";
import { createLLMClient } from "@companion/llm";
import { MemoryService, SqliteVecStore } from "@companion/memory";
import { loadSkillsDir, registerSkills } from "@companion/skills";
import { createToolRegistry } from "@companion/tools";
import { withSecurityHeaders } from "./security";
import { runStartupChecks } from "./startup-checks";

const log = new Logger("server");

const cfg = await loadConfig("./companion.yaml");
const store = new ConfigStore(cfg);
const db = await createDB(cfg);
const vectors = new SqliteVecStore(cfg.db.sqlite.path.replace(".db", "-vec.db"));
const { registry, sandbox } = createToolRegistry(cfg, db);

const skills = await loadSkillsDir("./skills");
registerSkills(skills, registry);
log.info(`Loaded ${skills.length} skill(s), ${registry.list().length} total tools`);

const embedModelName = cfg.vector.embedding.model;
const embedBase = (() => {
  const anyOllama = Object.values(cfg.models).find((m) => m.provider === "ollama");
  return (anyOllama?.base_url ?? "http://localhost:11434").replace(/\/$/, "");
})();

const embedClient = createLLMClient({
  provider: "ollama",
  model: embedModelName,
  base_url: embedBase,
  max_tokens: 1,
  temperature: 0,
});

const memory = new MemoryService(vectors, cfg);

let embedAvailable = false;
try {
  const tagsRes = await fetch(`${embedBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (tagsRes.ok) {
    const tags = (await tagsRes.json()) as { models?: Array<{ name: string }> };
    const names = tags.models?.map((m) => m.name) ?? [];
    embedAvailable = names.some((name) => name.startsWith(embedModelName.split(":")[0]!));
  }
} catch {
  // Startup checks log connectivity details.
}

if (embedAvailable) {
  log.info(`Embed model "${embedModelName}" ready - memory recall enabled`);
} else {
  log.warn(`Embed model "${embedModelName}" not found - memory recall disabled`);
  log.warn(`Run: ollama pull ${embedModelName}`);
}

registry.register({
  schema: {
    type: "function",
    function: {
      name: "search_memory",
      description: "Semantic search across past conversation memories for this session.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  handler: async (args, ctx) => {
    try {
      const query = String(args.query ?? "");
      const limit = Number(args.limit ?? 5);
      if (!embedAvailable) return "Memory recall not available (embed model not pulled)";
      const queryEmbed = await embedClient.embed(query);
      const results = await memory.recall(ctx.session_id, queryEmbed);
      const top = results.slice(0, limit);
      return top.length ? top.map((r, i) => `[${i + 1}] ${r}`).join("\n\n") : "No memories found.";
    } catch (error) {
      return `search_memory error: ${error}`;
    }
  },
});

interface ActiveTaskState {
  agent: string;
  tool?: string;
  thought?: string;
  status: "thinking" | "running_tool" | "synthesizing";
}

const activeTasks = new Map<string, ActiveTaskState>();
const activeCancels = new Map<string, AbortController>();

bus.on(EventType.AgentStart, (event) => {
  const payload = event.payload as Record<string, unknown>;
  activeTasks.set(event.session_id, { agent: String(payload.agent ?? ""), status: "thinking" });
});

bus.on(EventType.AgentThought, (event) => {
  const task = activeTasks.get(event.session_id);
  if (task) task.thought = String((event.payload as Record<string, unknown>).text ?? "");
});

bus.on(EventType.ToolStart, (event) => {
  const task = activeTasks.get(event.session_id);
  if (!task) return;
  task.tool = String((event.payload as Record<string, unknown>).tool ?? "");
  task.status = "running_tool";
});

bus.on(EventType.ToolEnd, (event) => {
  const task = activeTasks.get(event.session_id);
  if (!task) return;
  task.tool = undefined;
  task.status = "thinking";
});

bus.on(EventType.AgentEnd, (event) => {
  activeTasks.delete(event.session_id);
});

bus.on(EventType.Message, (event) => {
  activeTasks.delete(event.session_id);
});

type WS = import("bun").ServerWebSocket<{ session_id: string }>;
const subs = new Map<string, Set<WS>>();

function subscribe(ws: WS, sid: string): void {
  if (!subs.has(sid)) subs.set(sid, new Set());
  subs.get(sid)?.add(ws);
  ws.data.session_id = sid;
}

function broadcast(sid: string, event: CompanionEvent): void {
  const clients = subs.get(sid);
  if (!clients) return;
  const payload = JSON.stringify({ ...event, ts: event.ts.toISOString() });
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      clients.delete(ws);
    }
  }
}

bus.on("*", (event) => broadcast(event.session_id, event));

function authed(req: Request): boolean {
  const provided = req.headers.get("Authorization") ?? req.headers.get("x-api-key") ?? "";
  const secret = cfg.server.secret;
  return !secret || provided === `Bearer ${secret}` || provided === secret;
}

const E401 = () => Response.json({ error: "Unauthorized" }, { status: 401 });
const E404 = () => Response.json({ error: "Not found" }, { status: 404 });
const E400 = (msg: string) => Response.json({ error: msg }, { status: 400 });

async function storeMessageMemory(
  sid: SessionId,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!embedAvailable || !text.trim()) return;

  const chunks = memory.chunkText(text).slice(0, 8);
  for (const chunk of chunks) {
    const emb = await embedClient.embed(chunk.content);
    await memory.store(sid, `${Date.now().toString(36)}-${chunk.pageNum}`, chunk.content, emb, {
      ...metadata,
      page: chunk.pageNum,
      total_pages: chunk.totalPages,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
    });
  }
}

async function processMessage(
  sid: SessionId,
  session: Awaited<ReturnType<typeof db.sessions.get>>,
  content: string,
  workingDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!session) return;

  const sessionCfg = store.get(sid);
  const history = await db.messages.list(sid, { limit: sessionCfg.memory.context_window.max_messages });
  const bb = Blackboard.fromJSON(session.blackboard);

  const historyMsgs = history.map((msg) => ({
    role: msg.role,
    content: msg.content,
    tool_calls: msg.tool_calls as import("@companion/llm").OAIToolCall[] | undefined,
    tool_call_id: msg.tool_call_id,
    name: msg.name,
  }));

  let recallTexts: string[] = [];
  if (embedAvailable) {
    try {
      const recallQuery = [content, bb.goal, bb.read("observations").slice(-1)[0] ?? ""]
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
      const queryEmbed = await embedClient.embed(recallQuery);
      recallTexts = await memory.recall(sid, queryEmbed);
    } catch (error) {
      log.warn("Recall failed", error);
    }
  }

  const enrichedUserMessage = recallTexts.length
    ? `${content}\n\n[Relevant memories]\n${recallTexts.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
    : content;

  const processor = new SessionProcessor(sessionCfg, registry, memory, db);

  try {
    const result = await processor.handleMessage({
      session_id: sid,
      blackboard: bb,
      user_message: enrichedUserMessage,
      history: historyMsgs,
      working_dir: workingDir,
      mode: session.mode,
      signal,
    });

    const assistantMsg = await db.messages.add({
      id: asMessage(newId()),
      session_id: sid,
      role: MessageRole.Assistant,
      content: result.reply,
    });
    await db.sessions.incrementMessageCount(sid);

    await storeMessageMemory(sid, content, { role: "user" }).catch((error) => log.warn("Store user memory failed", error));
    await storeMessageMemory(sid, result.reply, { role: "assistant" }).catch((error) =>
      log.warn("Store assistant memory failed", error),
    );

    try {
      await db.sessions.update(sid, {
        blackboard: result.blackboard.toJSON(),
        expected_version: session.version,
      });
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        log.warn(`OCC conflict on ${sid} - blackboard not saved`);
        bus.emit({ type: EventType.Error, session_id: sid, ts: new Date(), payload: { error: error.message } });
      } else {
        throw error;
      }
    }

    bus.emit({ type: EventType.Message, session_id: sid, ts: new Date(), payload: assistantMsg });

    if (
      session.message_count > 0 &&
      session.message_count % sessionCfg.memory.summarisation.trigger_at_messages === 0
    ) {
      maybeSummarise(sid, sessionCfg).catch((error) => log.warn("Summarise failed", error));
    }
  } catch (error) {
    log.error("processMessage failed", error);
    bus.emit({ type: EventType.Error, session_id: sid, ts: new Date(), payload: { error: String(error) } });
  }
}

async function maybeSummarise(sid: SessionId, sessionCfg: typeof cfg): Promise<void> {
  if (!sessionCfg.memory.summarisation.enabled) return;
  const summaryAlias = sessionCfg.memory.summarisation.model;
  let summaryCfg = sessionCfg.models[summaryAlias];

  if (!summaryCfg) return;
  if ((summaryCfg.provider === "anthropic" || summaryCfg.provider === "openai" || summaryCfg.provider === "gemini") &&
      !summaryCfg.api_key) {
    const localFallback = sessionCfg.models.local;
    if (localFallback) {
      summaryCfg = localFallback;
    } else {
      return;
    }
  }

  const msgs = await db.messages.list(sid, { limit: 50 });
  const llm = createLLMClient(summaryCfg);
  const res = await llm.chat({
    messages: [
      { role: "system", content: "Summarise this conversation in 2-3 sentences." },
      { role: "user", content: msgs.map((m) => `${m.role}: ${m.content}`).join("\n") },
    ],
  });

  const summary = res.choices[0]?.message.content ?? "";
  if (summary) await db.sessions.update(sid, { summary });
}

async function handleHTTP(req: Request): Promise<Response> {
  if (!authed(req)) return E401();

  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path === "/health" && method === "GET") {
    return Response.json({ ok: true, ts: new Date().toISOString() });
  }

  if (path === "/capabilities" && method === "GET") {
    const agents = Object.entries(cfg.agents).map(([name, agent]) => ({
      name,
      description: agent.description,
      model: agent.model,
    }));
    return Response.json({
      tools: registry
        .list()
        .map((tool) => ({ name: tool.function.name, description: tool.function.description, source: "built-in" })),
      agents,
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      mode: cfg.mode.default,
    });
  }

  if (path === "/sessions" && method === "GET") {
    const sessions = await db.sessions.list();
    return Response.json({ sessions });
  }

  if (path === "/sessions" && method === "POST") {
    const body = (await req.json()) as { title?: string; goal?: string; mode?: string };
    const id = asSession(newId());
    const title = body.title ?? "New Session";
    const goal = body.goal ?? title;
    const mode = (body.mode ?? cfg.mode.default) as import("@companion/db").SessionMode;
    const session = await db.sessions.create(id, title, goal, mode);
    return Response.json({ session }, { status: 201 });
  }

  const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  if (!sessionMatch) return E404();

  const sid = asSession(sessionMatch[1]!);
  const subpath = sessionMatch[2] ?? "";
  const session = await db.sessions.get(sid);
  if (!session && subpath !== "") return E404();

  if (subpath === "" && method === "GET") {
    return Response.json({ session });
  }

  if (subpath === "" && method === "PATCH") {
    if (!session) return E404();
    const body = (await req.json()) as Record<string, unknown>;
    await db.sessions.update(sid, {
      title: body.title as string | undefined,
      mode: body.mode as import("@companion/db").SessionMode | undefined,
      status: body.status as import("@companion/db").SessionStatus | undefined,
    });
    return Response.json({ ok: true });
  }

  if (subpath === "" && method === "DELETE") {
    await db.sessions.delete(sid);
    return Response.json({ ok: true });
  }

  if (subpath === "/messages" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const messages = await db.messages.list(sid, { limit });
    return Response.json({ messages });
  }

  if (subpath === "/messages" && method === "POST") {
    if (!session) return E404();
    const body = (await req.json()) as { content: string; stream?: boolean; working_dir?: string };
    const content = body.content?.trim();
    if (!content) return E400("content is required");
    const workingDir = body.working_dir ?? process.cwd();

    const userMsg = await db.messages.add({
      id: asMessage(newId()),
      session_id: sid,
      role: MessageRole.User,
      content,
    });
    await db.sessions.incrementMessageCount(sid);

    if (body.stream) {
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController;

      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
      });

      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream already closed.
        }
      };

      const unsub = bus.on("*", (event) => {
        if (event.session_id !== sid) return;
        if (event.type === EventType.Message) {
          const m = event.payload as { content: string };
          send({ type: "text", text: m.content });
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          unsub();
        }
        if (event.type === EventType.AgentThought) send({ type: "thought", ...(event.payload as object) });
        if (event.type === EventType.ToolStart) send({ type: "tool_start", ...(event.payload as object) });
        if (event.type === EventType.ToolEnd) send({ type: "tool_end", ...(event.payload as object) });
        if (event.type === EventType.Error) send({ type: "error", ...(event.payload as object) });
      });

      const ctrl = new AbortController();
      activeCancels.set(sid, ctrl);
      processMessage(sid, session, content, workingDir, ctrl.signal)
        .catch((error) => {
          send({ type: "error", error: String(error) });
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          unsub();
        })
        .finally(() => {
          activeCancels.delete(sid);
        });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const ctrl = new AbortController();
    activeCancels.set(sid, ctrl);
    processMessage(sid, session, content, workingDir, ctrl.signal)
      .catch((error) => log.error("processMessage", error))
      .finally(() => activeCancels.delete(sid));

    return Response.json({ message: userMsg }, { status: 202 });
  }

  if (subpath === "/blackboard" && method === "GET") {
    if (!session) return E404();
    return Response.json({ blackboard: JSON.parse(session.blackboard) });
  }

  return E404();
}

Bun.serve<{ session_id: string }>({
  port: cfg.server.port,
  hostname: cfg.server.host,
  idleTimeout: 0,
  fetch(req, server) {
    if (req.headers.get("Upgrade") === "websocket") {
      const url = new URL(req.url);
      const token = url.searchParams.get("token") ?? "";
      const secret = cfg.server.secret;
      if (secret && token !== secret) return withSecurityHeaders(E401());
      const sid = url.searchParams.get("session") ?? "";
      const ok = server.upgrade(req, { data: { session_id: sid } });
      if (!ok) return withSecurityHeaders(new Response("WS upgrade failed", { status: 500 }));
      return undefined;
    }

    return handleHTTP(req).then(withSecurityHeaders);
  },
  websocket: {
    open(ws: WS) {
      if (!ws.data.session_id) return;
      subscribe(ws, ws.data.session_id);
      ws.send(JSON.stringify({ type: "connected", session_id: ws.data.session_id }));
      const task = activeTasks.get(ws.data.session_id) ?? null;
      ws.send(
        JSON.stringify({
          type: "sync_state",
          session_id: ws.data.session_id,
          payload: task,
          ts: new Date().toISOString(),
        }),
      );
    },
    message(ws: WS, raw: string | Buffer) {
      try {
        const msg = JSON.parse(String(raw)) as { type: string; session_id?: string };

        if (msg.type === "subscribe" && msg.session_id) {
          subs.get(ws.data.session_id)?.delete(ws);
          subscribe(ws, msg.session_id);
          ws.send(JSON.stringify({ type: "subscribed", session_id: msg.session_id }));
          const task = activeTasks.get(msg.session_id) ?? null;
          ws.send(
            JSON.stringify({
              type: "sync_state",
              session_id: msg.session_id,
              payload: task,
              ts: new Date().toISOString(),
            }),
          );
        }

        if (msg.type === "cancel" && msg.session_id) {
          const ctrl = activeCancels.get(msg.session_id);
          if (!ctrl) return;
          ctrl.abort();
          activeCancels.delete(msg.session_id);
          log.info(`Session ${msg.session_id} cancelled via WS`);
          ws.send(JSON.stringify({ type: "cancelled", session_id: msg.session_id }));
          bus.emit({
            type: EventType.Error,
            session_id: msg.session_id as SessionId,
            ts: new Date(),
            payload: { error: "cancelled" },
          });
        }
      } catch (error) {
        log.debug(`WS message parse error: ${error}`);
      }
    },
    close(ws: WS) {
      subs.get(ws.data.session_id)?.delete(ws);
    },
  },
});

await runStartupChecks({ cfg, sandbox, embedBase, embedModelName });

log.info(`Server listening on ${cfg.server.host}:${cfg.server.port}`);
log.info(`DB: ${cfg.db.driver} | Tools: ${registry.list().length} | Skills: ${skills.length}`);
