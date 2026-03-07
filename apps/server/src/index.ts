/**
 * @companion/server
 *
 * HTTP + WebSocket server using Bun.serve().
 * No Express, no Hono — Bun's built-in server is sufficient and has no deps.
 *
 * Routes:
 *   GET    /health
 *   GET    /capabilities
 *   GET    /sessions
 *   POST   /sessions
 *   GET    /sessions/:id
 *   PATCH  /sessions/:id
 *   DELETE /sessions/:id
 *   GET    /sessions/:id/messages
 *   POST   /sessions/:id/messages      (stream: true → SSE)
 *   GET    /sessions/:id/blackboard
 *   WS     /ws?session=:id&token=:token
 */

import { loadConfig, ConfigStore } from "@companion/config";
import {
  Blackboard,
  Logger,
  bus,
  newId,
  asSession,
  asMessage,
  type SessionId,
  type CompanionEvent,
} from "@companion/core";
import { createDB, ConcurrencyError } from "@companion/db";
import { createLLMClient } from "@companion/llm";
import { SqliteVecStore, MemoryService } from "@companion/memory";
import { createToolRegistry } from "@companion/tools";
import { loadSkillsDir, registerSkills } from "@companion/skills";
import { SessionProcessor } from "@companion/agents";

const log = new Logger("server");

// ── Bootstrap ─────────────────────────────────────────────────

const cfg = await loadConfig("./companion.yaml");
const store = new ConfigStore(cfg);
const db = await createDB(cfg);
const vectors = new SqliteVecStore(cfg.db.sqlite.path.replace(".db", "-vec.db"));
const { registry, sandbox } = createToolRegistry(cfg, db);

// Load skills
const skills = await loadSkillsDir("./skills");
registerSkills(skills, registry);
log.info(`Loaded ${skills.length} skill(s), ${registry.list().length} total tools`);

// Register search_memory — needs the vector store, so wired here after memory init
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
      const query = String(args["query"] ?? "");
      const limit = Number(args["limit"] ?? 5);
      if (!embedAvailable) return "Memory recall not available (embed model not pulled)";
      const queryEmbed = await embedClient.embed(query);
      const results = await memory.recall(ctx.session_id, queryEmbed);
      const top = results.slice(0, limit);
      return top.length ? top.map((r, i) => `[${i + 1}] ${r}`).join("\n\n") : "No memories found.";
    } catch (e) {
      return `search_memory error: ${e}`;
    }
  },
});

// Embedding model for memory recall.
// Uses nomic-embed-text (cfg.vector.embedding.model) via Ollama /api/embed.
// If the model is not pulled, recall is DISABLED for the session — no 500 spam.
// Pull:  ollama pull nomic-embed-text
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

// Check embed model availability once at startup — disable recall if missing.
// Avoids a 500 error on every single message when the model is not pulled.
let embedAvailable = false;
try {
  const tagsRes = await fetch(`${embedBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (tagsRes.ok) {
    const tags = (await tagsRes.json()) as { models?: Array<{ name: string }> };
    const names = tags.models?.map((m) => m.name) ?? [];
    embedAvailable = names.some((n) => n.startsWith(embedModelName.split(":")[0]!));
  }
} catch {
  /* Ollama not reachable — already warned above */
}

if (embedAvailable) {
  log.info(`Embed model "${embedModelName}" ready — memory recall enabled`);
} else {
  log.warn(`Embed model "${embedModelName}" not found — memory recall disabled.`);
  log.warn(`Run: ollama pull ${embedModelName}   (small model, ~274MB)`);
}

// ── Active task tracking (for WS sync_state on reconnect) ────

interface ActiveTaskState {
  agent: string;
  tool?: string;
  thought?: string;
  status: "thinking" | "running_tool" | "synthesizing";
}
const activeTasks = new Map<string, ActiveTaskState>();
const activeCancels = new Map<string, AbortController>(); // session_id → cancel

bus.on("agent_start", (e) => {
  const p = e.payload as Record<string, unknown>;
  activeTasks.set(e.session_id, { agent: String(p["agent"] ?? ""), status: "thinking" });
});
bus.on("agent_thought", (e) => {
  const t = activeTasks.get(e.session_id);
  if (t) t.thought = String((e.payload as Record<string, unknown>)["text"] ?? "");
});
bus.on("tool_start", (e) => {
  const t = activeTasks.get(e.session_id);
  if (t) {
    t.tool = String((e.payload as Record<string, unknown>)["tool"] ?? "");
    t.status = "running_tool";
  }
});
bus.on("tool_end", (e) => {
  const t = activeTasks.get(e.session_id);
  if (t) {
    t.tool = undefined;
    t.status = "thinking";
  }
});
bus.on("agent_end", (e) => {
  activeTasks.delete(e.session_id);
});
bus.on("message", (e) => {
  activeTasks.delete(e.session_id);
});

// ── WebSocket subscriptions ───────────────────────────────────

type WS = import("bun").ServerWebSocket<{ session_id: string }>;
const subs = new Map<string, Set<WS>>();

function subscribe(ws: WS, sid: string): void {
  if (!subs.has(sid)) subs.set(sid, new Set());
  subs.get(sid)!.add(ws);
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

bus.on("*", (e) => broadcast(e.session_id, e));

// ── Auth ──────────────────────────────────────────────────────

function authed(req: Request): boolean {
  const h = req.headers.get("Authorization") ?? req.headers.get("x-api-key") ?? "";
  const s = cfg.server.secret;
  return !s || h === `Bearer ${s}` || h === s;
}

const E401 = () => Response.json({ error: "Unauthorized" }, { status: 401 });
const E404 = () => Response.json({ error: "Not found" }, { status: 404 });
const E400 = (msg: string) => Response.json({ error: msg }, { status: 400 });

// ── Message processor ─────────────────────────────────────────

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

  const historyMsgs = history.map((m) => ({
    role: m.role as "user" | "assistant" | "system" | "tool",
    content: m.content,
    tool_calls: m.tool_calls as import("@companion/llm").OAIToolCall[] | undefined,
    tool_call_id: m.tool_call_id,
    name: m.name,
  }));

  // Recall — enrich query with goal + latest observation for short messages
  let recallTexts: string[] = [];
  if (embedAvailable) {
    try {
      const recallQuery = [content, bb.goal, bb.read("observations").slice(-1)[0] ?? ""]
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
      const queryEmbed = await embedClient.embed(recallQuery);
      recallTexts = await memory.recall(sid, queryEmbed);
    } catch (e) {
      log.warn("Recall failed", e);
    }
  }

  void recallTexts; // used by agent system prompt via memory.buildContext

  const processor = new SessionProcessor(sessionCfg, registry, memory, db);

  try {
    const result = await processor.handleMessage({
      session_id: sid,
      blackboard: bb,
      user_message: content,
      history: historyMsgs,
      working_dir: workingDir,
      mode: session.mode,
      signal,
    });

    const assistantMsg = await db.messages.add({
      id: asMessage(newId()),
      session_id: sid,
      role: "assistant",
      content: result.reply,
    });
    await db.sessions.incrementMessageCount(sid);

    // OCC blackboard save
    try {
      await db.sessions.update(sid, {
        blackboard: result.blackboard.toJSON(),
        expected_version: session.version,
      });
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        log.warn(`OCC conflict on ${sid} — blackboard not saved`);
        bus.emit({ type: "error", session_id: sid, ts: new Date(), payload: { error: e.message } });
      } else {
        throw e;
      }
    }

    bus.emit({ type: "message", session_id: sid, ts: new Date(), payload: assistantMsg });

    // Auto-summarise long sessions
    if (
      session.message_count > 0 &&
      session.message_count % sessionCfg.memory.summarisation.trigger_at_messages === 0
    ) {
      maybeSummarise(sid, sessionCfg).catch((e) => log.warn("Summarise failed", e));
    }
  } catch (e) {
    log.error("processMessage failed", e);
    bus.emit({ type: "error", session_id: sid, ts: new Date(), payload: { error: String(e) } });
  }
}

async function maybeSummarise(sid: SessionId, sessionCfg: typeof cfg): Promise<void> {
  if (!sessionCfg.memory.summarisation.enabled) return;
  const summaryAlias = sessionCfg.memory.summarisation.model;
  const summaryCfg = sessionCfg.models[summaryAlias];
  if (!summaryCfg) return;

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

// ── HTTP handler ──────────────────────────────────────────────

async function handleHTTP(req: Request): Promise<Response> {
  if (!authed(req)) return E401();

  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // GET /health
  if (path === "/health" && method === "GET") {
    return Response.json({ ok: true, ts: new Date().toISOString() });
  }

  // GET /capabilities
  if (path === "/capabilities" && method === "GET") {
    const agents = Object.entries(cfg.agents).map(([name, a]) => ({
      name,
      description: a.description,
      model: a.model,
    }));
    return Response.json({
      tools: registry
        .list()
        .map((t) => ({ name: t.function.name, description: t.function.description, source: "built-in" })),
      agents,
      skills: skills.map((s) => ({ name: s.name, description: s.description })),
      mode: cfg.mode.default,
    });
  }

  // GET /sessions
  if (path === "/sessions" && method === "GET") {
    const sessions = await db.sessions.list();
    return Response.json({ sessions });
  }

  // POST /sessions
  if (path === "/sessions" && method === "POST") {
    const body = (await req.json()) as { title?: string; goal?: string; mode?: string };
    const id = asSession(newId());
    const title = body.title ?? "New Session";
    const goal = body.goal ?? title;
    const mode = (body.mode ?? cfg.mode.default) as import("@companion/db").SessionMode;
    const session = await db.sessions.create(id, title, goal, mode);
    return Response.json({ session }, { status: 201 });
  }

  // /sessions/:id routes
  const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const sid = asSession(sessionMatch[1]!);
    const subpath = sessionMatch[2] ?? "";
    const session = await db.sessions.get(sid);
    if (!session && subpath !== "") return E404();

    // GET /sessions/:id
    if (subpath === "" && method === "GET") {
      return Response.json({ session });
    }

    // PATCH /sessions/:id
    if (subpath === "" && method === "PATCH") {
      if (!session) return E404();
      const body = (await req.json()) as Record<string, unknown>;
      await db.sessions.update(sid, {
        title: body["title"] as string | undefined,
        mode: body["mode"] as import("@companion/db").SessionMode | undefined,
        status: body["status"] as import("@companion/db").SessionStatus | undefined,
      });
      return Response.json({ ok: true });
    }

    // DELETE /sessions/:id
    if (subpath === "" && method === "DELETE") {
      await db.sessions.delete(sid);
      return Response.json({ ok: true });
    }

    // GET /sessions/:id/messages
    if (subpath === "/messages" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const msgs = await db.messages.list(sid, { limit });
      return Response.json({ messages: msgs });
    }

    // POST /sessions/:id/messages
    if (subpath === "/messages" && method === "POST") {
      if (!session) return E404();
      const body = (await req.json()) as { content: string; stream?: boolean; working_dir?: string };
      const content = body.content?.trim();
      if (!content) return E400("content is required");
      const workingDir = body.working_dir ?? process.cwd();

      const userMsg = await db.messages.add({
        id: asMessage(newId()),
        session_id: sid,
        role: "user",
        content,
      });
      await db.sessions.incrementMessageCount(sid);

      if (body.stream) {
        // SSE streaming response
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
            /* stream closed */
          }
        };

        // Stream agent events as SSE
        const unsub = bus.on("*", (e) => {
          if (e.session_id !== sid) return;
          if (e.type === "message") {
            const m = e.payload as { content: string };
            send({ type: "text", text: m.content });
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            unsub();
          }
          if (e.type === "agent_thought") send({ type: "thought", ...(e.payload as object) });
          if (e.type === "tool_start") send({ type: "tool_start", ...(e.payload as object) });
          if (e.type === "tool_end") send({ type: "tool_end", ...(e.payload as object) });
          if (e.type === "error") send({ type: "error", ...(e.payload as object) });
        });

        const ctrl = new AbortController();
        activeCancels.set(sid, ctrl);

        processMessage(sid, session, content, workingDir, ctrl.signal)
          .catch((e) => {
            send({ type: "error", error: String(e) });
            try {
              controller.close();
            } catch {
              /* already closed */
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

      // Async non-streaming — 202
      const ctrl202 = new AbortController();
      activeCancels.set(sid, ctrl202);
      processMessage(sid, session, content, workingDir, ctrl202.signal)
        .catch((e) => log.error("processMessage", e))
        .finally(() => activeCancels.delete(sid));
      return Response.json({ message: userMsg }, { status: 202 });
    }

    // GET /sessions/:id/blackboard
    if (subpath === "/blackboard" && method === "GET") {
      if (!session) return E404();
      return Response.json({ blackboard: JSON.parse(session.blackboard) });
    }
  }

  return E404();
}

// ── Bun.serve ─────────────────────────────────────────────────

Bun.serve<{ session_id: string }>({
  port: cfg.server.port,
  hostname: cfg.server.host,
  idleTimeout: 0, // disable Bun's 10s default — LLM calls take much longer

  fetch(req, server) {
    // WebSocket upgrade
    if (req.headers.get("Upgrade") === "websocket") {
      const url = new URL(req.url);
      const token = url.searchParams.get("token") ?? "";
      const s = cfg.server.secret;
      if (s && token !== s) return E401();
      const sid = url.searchParams.get("session") ?? "";
      const ok = server.upgrade(req, { data: { session_id: sid } });
      return ok ? undefined : new Response("WS upgrade failed", { status: 500 });
    }
    return handleHTTP(req);
  },

  websocket: {
    open(ws: WS) {
      if (ws.data.session_id) {
        subscribe(ws, ws.data.session_id);
        ws.send(JSON.stringify({ type: "connected", session_id: ws.data.session_id }));
        // Push current task state — clears dead spinners on reconnect
        const task = activeTasks.get(ws.data.session_id) ?? null;
        ws.send(
          JSON.stringify({
            type: "sync_state",
            session_id: ws.data.session_id,
            payload: task,
            ts: new Date().toISOString(),
          }),
        );
      }
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
        // Cancel a running task server-side
        if (msg.type === "cancel" && msg.session_id) {
          const ctrl = activeCancels.get(msg.session_id);
          if (ctrl) {
            ctrl.abort();
            activeCancels.delete(msg.session_id);
            log.info(`Session ${msg.session_id} cancelled via WS`);
            ws.send(JSON.stringify({ type: "cancelled", session_id: msg.session_id }));
            // Emit cancellation event so TUI clears spinner
            bus.emit({
              type: "error",
              session_id: msg.session_id as SessionId,
              ts: new Date(),
              payload: { error: "cancelled" },
            });
          }
        }
      } catch (e) {
        log.debug(`WS message parse error: ${e}`);
      }
    },
    close(ws: WS) {
      subs.get(ws.data.session_id)?.delete(ws);
    },
    error(ws: WS, err: Error) {
      log.error("WS error", err);
    },
  },
});

// Startup tasks
sandbox.cleanupZombies().catch((e) => log.warn("Zombie cleanup error", e));

// Check embed model availability
try {
  const embedCheckRes = await fetch(`${embedBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (embedCheckRes.ok) {
    const tags = (await embedCheckRes.json()) as { models?: Array<{ name: string }> };
    const available = tags.models?.map((x) => x.name) ?? [];
    const embedPresent = available.some((n) => n.startsWith(embedModelName.split(":")[0]!));
    if (embedPresent) {
      log.info(`Embed model "${embedModelName}" — ready`);
    } else {
      log.warn(`Embed model "${embedModelName}" not found in Ollama. Run: ollama pull ${embedModelName}`);
      log.warn("Semantic recall will be disabled until the embed model is pulled.");
    }
  }
} catch {
  log.warn(`Cannot check embed model "${embedModelName}" — Ollama not reachable`);
}

// Check Ollama availability for any locally-configured models
const ollamaModels = Object.entries(cfg.models).filter(([, m]) => m.provider === "ollama");
for (const [alias, m] of ollamaModels) {
  const base = (m.base_url ?? "http://localhost:11434").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const available = data.models?.map((x) => x.name) ?? [];
      const present = available.some((n) => n.startsWith(m.model.split(":")[0]!));
      if (present) {
        log.info(`Ollama model "${m.model}" (alias: ${alias}) — ready`);
      } else {
        log.warn(`Ollama is running but model "${m.model}" not found. Run: ollama pull ${m.model}`);
        log.warn(`Available: ${available.join(", ") || "(none)"}`);
      }
    }
  } catch {
    log.warn(`Ollama not reachable at ${base} for model alias "${alias}". Start Ollama or set OLLAMA_BASE_URL.`);
  }
}

log.info(`Server listening on ${cfg.server.host}:${cfg.server.port}`);
log.info(`DB: ${cfg.db.driver} | Tools: ${registry.list().length} | Skills: ${skills.length}`);
