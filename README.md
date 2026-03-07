# Companion

Local-first AI agent system. Bun monorepo, SQLite, Ollama by default.

By Radoslav Sandov

## Requirements - needs to be present before you start

- Bun >= 1.1.0 - installation guide [here](https://bun.com/)
- Ollama >= 0.17.7 running locally (default) or API keys for cloud providers - installation guide [here](https://ollama.com/)

## Setup

```bash
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY or other keys as needed

bun install
bun test
# pull the local model if you would like to use local first
ollama serve # if not currently running
bun run pull # to pull the model
```

## Run

```bash
# Server (port 3000 by default)
bun run apps/server/src/index.ts
# or 
bun run server

# TUI (separate terminal)
bun run apps/tui/src/index.tsx
# or 
bun run tui
```

# Example: "What is the current system load?" — Local LLM, No API Key

This quickstart traces a single message through the full Companion stack, showing
every actual function call, every prompt, and every response. Nothing is invented.

---

## Prerequisites

```bash
ollama serve                   # Ollama running
bun run pull                   # qwen2.5:3b is present
bun server                     # run server
# on another terminal if you need to use the tui and not using the curl commands
bun run tui
```

`companion.yaml` must have engineer set to local:

```yaml
orchestrator:
  model: local

agents:
  engineer:
    model: local        # default is "smart" — change this for no-API-key usage
```

---

## The request

```bash
curl -s -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"sysinfo","goal":"check system state"}'
```

Returns `{ "session": { "id": "abc123", ... } }`. Then:

```bash
curl -s -X POST http://localhost:3000/sessions/abc123/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"What is the current system load?"}'
```

---

## Step 1 — Server receives the message

`apps/server/src/index.ts` → `handleHTTP()` → `processMessage()`

```
POST /sessions/abc123/messages
content: "What is the current system load?"
```

`processMessage()` does three things before handing off:

1. Loads history from SQLite (empty — new session)
2. Attempts recall: calls `embedClient.embed("What is the current system load?")` →
   Ollama `/api/embeddings` → returns float32[768] → `memory.recall()` → no stored memories yet → `[]`
3. Creates `SessionProcessor` and calls `handleMessage()`

---

## Step 2 — Orchestrator decides (Round 1)

`packages/agents/src/index.ts` → `SessionProcessor.handleMessage()`

**Model:** `qwen2.5:3b` via Ollama, `json_mode: true` (Ollama `"format":"json"`)

**Prompt sent to `http://localhost:11434/v1/chat/completions`:**

```
[system]
You are an orchestrator. Your ONLY job is to decide which agent to call next.
DO NOT do the work yourself. DO NOT call write_file, read_file, or any task tool directly.
If the user wants code written, route to 'engineer'. If analysis is needed, route to 'analyst'.
Use 'reply' or 'done' only after agents have produced the answer.

Mode: local

Goal: check system state

Respond with ONLY valid JSON in this exact shape:
{"action":"run_agent","target":"engineer","reason":"needs code written"}
{"action":"run_agent","target":"analyst","reason":"needs data analysis"}
{"action":"reply","target":"responder","reason":"ready to synthesise"}
{"action":"done","reason":"task complete, already replied"}

[user]
What is the current system load?
```

**qwen2.5:3b response:**

```json
{"action":"run_agent","target":"engineer","reason":"need to run shell command to check system load"}
```

Orchestrator parses this, appends to blackboard decisions:
```
[Round 1] run_agent → engineer
```

Emits `orchestrator_decision` event → TUI action log shows:
```
◆ [R1] run_agent → engineer
```

---

## Step 3 — Engineer agent runs (ReAct loop)

`AgentRunner.run()` for agent `"engineer"`, model `qwen2.5:3b`

**Key decision:** `modelSupportsTools("qwen2.5:3b")` returns `false` — qwen2.5:3b is in
the `noTools` blocklist. Engineer uses **JSON-mode ReAct**, not structured tool calls.

The engineer's system prompt is built from the blackboard view (`reads_from: [goal, observations, artifacts]`):

```
[system]
You are the engineer agent. Writes, edits, and tests code. Uses file and shell tools to implement features.

Blackboard:
Goal: check system state

Use the provided tools to complete the task.

You must respond with ONLY valid JSON. No markdown, no explanation.
Available tools:
- read_file: Read a file, or a specific page of a large file.
- write_file: Write content to a file.
- list_dir: List files and directories at a path.
- run_shell: Run a shell command in the sandbox.
- run_tests: Run the test suite in the working directory.
- search_history: Full-text search across message history.

To call a tool: {"thought":"why","tool":"tool_name","args":{"param":"value"}}
When done:      {"thought":"reasoning","action":"final_answer","result":"your answer"}

[user]
What is the current system load?
```

**Turn 1 — qwen2.5:3b responds:**

```json
{
  "thought": "I need to check the system load using the uptime command",
  "tool": "run_shell",
  "args": { "command": "uptime && cat /proc/loadavg" }
}
```

`parseReActResponse()` converts this to an internal tool_calls structure, emits:
```
agent_thought  → "I need to check the system load using the uptime command"
tool_start     → run_shell
```

TUI shows:
```
⚙ engineer — running tool…
  ↳ tool: run_shell
  ❝ I need to check the system load using the uptime command
```

---

## Step 4 — run_shell executes

`packages/tools/src/index.ts` → `runShellTool.handler()`

Checks if Docker is available (`docker info`). Two cases:

**With Docker** (sandbox image present):
```bash
docker run --rm \
  --network=none \
  --label=managed_by=companion \
  --volume=/path/to/working_dir:/workspace:rw \
  --workdir=/workspace \
  companion-sandbox:latest \
  sh -c "uptime && cat /proc/loadavg"
```

**Without Docker** (direct execution):
```bash
sh -c "uptime && cat /proc/loadavg"
```

**Output returned:**
```
 14:23:11 up 3 days, 2:41,  2 users,  load average: 0.45, 0.38, 0.31
0.45 0.38 0.31 2/412 84231
```

Tool result is formatted:
```
Exit: 0
stdout:
 14:23:11 up 3 days, 2:41,  2 users,  load average: 0.45, 0.38, 0.31
0.45 0.38 0.31 2/412 84231
```

Emits `tool_end` → TUI action log:
```
  ✓ run_shell (47ms)
```

---

## Step 5 — Engineer synthesises

Tool result is appended to messages. Engineer gets another LLM call:

```
[tool result]
Exit: 0
stdout:
 14:23:11 up 3 days, 2:41,  2 users,  load average: 0.45, 0.38, 0.31
0.45 0.38 0.31 2/412 84231
```

**qwen2.5:3b responds:**

```json
{
  "thought": "I have the system load information, I can now provide the answer",
  "action": "final_answer",
  "result": "The current system load averages are 0.45 (1 min), 0.38 (5 min), and 0.31 (15 min). The system has been up for 3 days, 2 hours, and 41 minutes with 2 active users. Load looks healthy — all values are well below 1.0."
}
```

`parseReActResponse()` sees `action: "final_answer"` → returns as plain text message, no more tool calls.

Emits `agent_end` → TUI:
```
← done (done)
```

---

## Step 6 — Orchestrator verifies (asymmetric check)

Back in `SessionProcessor.handleMessage()`:

```typescript
const shouldVerify = cfg.orchestrator.verify_results &&
  !(orchCfg.provider === "ollama" && cfg.models[agentModelAlias]?.provider !== "ollama");
```

Both orchestrator and engineer are `ollama` → `shouldVerify = true` (local verifying local).

Orchestrator (qwen2.5:3b) gets:
```
Task: What is the current system load?
Agent reply: The current system load averages are 0.45 (1 min)...
Is the reply correct and complete?
```

Returns: `{"ok":true,"reason":"load averages provided with context"}`

Blackboard observation appended:
```
[engineer] The current system load averages are 0.45 (1 min), 0.38 (5 min)...
```

---

## Step 7 — Orchestrator routes to responder (Round 2)

Orchestrator sees a completed observation, routes to `responder`:

```json
{"action":"reply","target":"responder","reason":"ready to synthesise for user"}
```

Responder agent (model: `fast`, which is also `local` in a no-key setup) synthesises
from `reads_from: [goal, observations, artifacts, decisions]` and returns the final message.

---

## Step 8 — Response saved and delivered

`apps/server/src/index.ts`:

```typescript
const assistantMsg = await db.messages.add({ role: "assistant", content: result.reply, ... });
await db.sessions.update(sid, { blackboard: result.blackboard.toJSON(), expected_version: session.version });
bus.emit({ type: "message", session_id: sid, payload: assistantMsg });
```

WebSocket clients (TUI) receive:
```json
{ "type": "message", "payload": { "role": "assistant", "content": "The current system load..." } }
```

HTTP caller (if using `stream: false`) gets 202 immediately, then picks up the message
via WebSocket or by polling `GET /sessions/abc123/messages`.

---

## Final output in TUI

```
Companion
The current system load averages are 0.45 (1 min), 0.38 (5 min), and 0.31 (15 min).
The system has been up for 3 days, 2 hours, and 41 minutes with 2 active users.
Load looks healthy — all values are well below 1.0.
```

---

## What changes if Ollama is not running

`LLMClient.oaiChat()` calls `fetch("http://localhost:11434/v1/chat/completions", ...)` →
throws `TypeError: fetch failed` → caught in `AgentRunner.run()` → returns
`{ reply: "Agent error: TypeError: fetch failed", stopped_reason: "error" }` →
server emits `error` event → TUI logs `ERR: Agent error: TypeError: fetch failed`.

On **server startup**, the health check already warned:
```
[warn] Ollama not reachable at http://localhost:11434 for model alias "local". Start Ollama or set OLLAMA_BASE_URL.
```

---

## Total LLM calls for this query

| Call | Model | Purpose |
|------|-------|---------|
| 1 | qwen2.5:3b | Embed recall query |
| 2 | qwen2.5:3b | Orchestrator decides (Round 1) |
| 3 | qwen2.5:3b | Engineer Turn 1 — decides to call run_shell |
| 4 | qwen2.5:3b | Engineer Turn 2 — synthesises tool result |
| 5 | qwen2.5:3b | Orchestrator verify |
| 6 | qwen2.5:3b | Orchestrator decides (Round 2) → responder |
| 7 | qwen2.5:3b | Responder synthesises final reply |

**7 calls to local Ollama. Zero API calls. Zero spend.**

## Test

```bash
bun test                    # all packages
bun test packages/core      # single package
```

## Turbo (parallel builds/tests)

```bash
bun x turbo run test
bun x turbo run typecheck
```

## Project layout

```
packages/
  config/     Zod config schema, YAML loader, ConfigStore
  core/       Blackboard, EventBus, Logger, branded IDs
  db/         bun:sqlite (WAL+FTS5+OCC) + postgres.js
  llm/        LLMClient — Anthropic, OpenAI, Ollama, Gemini, Copilot
  memory/     VectorStore, SlidingWindow, ContextBuilder
  tools/      ToolRegistry, built-in tools, SandboxExecutor
  skills/     YAML skill loader, COMPANION_ARG_* injection
  agents/     Orchestrator, AgentRunner (ReAct + structured)

apps/
  server/     Bun.serve HTTP+WS, SSE streaming
  tui/        Ink terminal UI

skills/       bash, file-edit, database
```

## Config

All config lives in `companion.yaml`. Environment variables interpolated as `${VAR:-default}`.

Key settings:
- `orchestrator.model` — which model alias drives orchestration (default: `local`)
- `agents.*` — per-agent model, tools, max_turns
- `mode.default` — `local` | `balanced` | `cloud`

## Adding skills

Create `skills/my-skill/skill.yaml`. Arguments arrive as `$COMPANION_ARG_PARAM` (bash) or `process.env.COMPANION_ARG_PARAM` (JS). See `skills/bash/skill.yaml` for a minimal example.

## Adding models

Add an entry under `models:` in `companion.yaml`:

```yaml
models:
  my-model:
    provider: openai
    model:    gpt-4o
    api_key:  ${OPENAI_API_KEY}
```

Then reference it in `agents.*.model` or `orchestrator.model`.



# Companion — User Guide

Companion is a local-first AI agent system. Your conversations stay on your machine.
No data leaves unless you configure a cloud model.

---

## Installation

### 1. Install Ollama

Ollama runs AI models locally.

**Linux / WSL:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**macOS:**
Download from [ollama.com](https://ollama.com) or:
```bash
brew install ollama
```

**Start Ollama:**
```bash
ollama serve
```

On macOS, Ollama starts automatically at login after installation.

### 2. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

Requires Bun ≥ 1.1.0.

### 3. Install and set up Companion

```bash
cp .env.example .env
bun run setup         # installs dependencies and pulls the default model
```

`bun run setup` will tell you if Ollama is not running or if the model is missing.

---

## Starting the server and TUI

```bash
# Terminal 1
bun run server

# Terminal 2
bun run tui
```

The server runs on port 3000 by default. You can also use the HTTP API directly
(see [API Reference](#api-reference)).

---

## TUI navigation

| Key | Action |
|-----|--------|
| `Tab` | Switch between Sessions / Chat / Capabilities panes |
| `n` | New session (in Sessions pane) |
| `d` | Delete selected session |
| `Enter` | Open selected session |
| `/` | Focus message input |
| `Enter` (in input) | Send message |
| `Esc` | Unfocus input; abort a running request |
| `↑` / `↓` | Scroll messages when input is unfocused |
| `↩` | Jump to bottom of messages |
| `1` / `2` / `3` | Switch mode: local / balanced / cloud |
| `q` | Quit (from Sessions pane) |

---

## Modes

Modes control which models handle your requests.

### `local` (default)

All processing on your machine via Ollama. No API keys required. Slower for complex tasks.

```yaml
# companion.yaml
orchestrator:
  model: local
agents:
  engineer:
    model: local
  analyst:
    model: local
  responder:
    model: local
```

Switch in TUI: press `1`

### `balanced`

Local model orchestrates. Cloud agents handle heavy tasks (code, analysis).
Requires one cloud API key.

Switch in TUI: press `2`

### `cloud`

Cloud model orchestrates and all agents use cloud. Maximum capability.
Requires API key.

Switch in TUI: press `3`

---

## Adding API keys

Edit `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
```

Then change model aliases in `companion.yaml` to use them:

```yaml
agents:
  engineer:
    model: smart      # uses Anthropic claude-sonnet by default
```

No restart needed for model alias changes — the server reloads config per request.
API key changes require a server restart.

---

## Changing the local model

Edit `companion.yaml`:

```yaml
models:
  local:
    model: llama3.2:3b     # any model name from: ollama list
```

Then pull it:

```bash
bun run pull
```

`bun run pull` is idempotent — runs safely any time.

Available models: `ollama list` shows what you have. `ollama search <name>` finds more.

Good options by size:
| Model | Size | Good for |
|-------|------|----------|
| `qwen2.5:3b` | 2GB | Default — fast, decent reasoning |
| `qwen2.5:7b` | 4.7GB | Better reasoning, still fast |
| `llama3.2:3b` | 2GB | Good general purpose |
| `llama3.1:8b` | 4.9GB | Strong reasoning, needs 8GB RAM |
| `mistral:7b` | 4.1GB | Good at following instructions |
| `deepseek-r1:7b` | 4.7GB | Strong at step-by-step reasoning |

---

## What Companion can do

### Shell commands

> "What is the current system load?"

> "How much disk space is free?"

> "List running processes sorted by memory"

Engineer agent calls `run_shell` with `uptime`, `df -h`, `ps aux --sort=-%mem`.
Results are interpreted and summarised.

### File operations

> "Read the contents of src/main.ts"

> "Create a file called notes.md with a summary of our conversation"

> "List all TypeScript files in the current directory"

### Code tasks (with cloud model)

> "Write a Python script that parses this CSV and outputs a summary"

> "Fix the bug in the code I'm about to paste"

> "Add error handling to this function"

### Research and recall

> "What did we discuss about the database schema?"

> "Summarise the decisions from our last session"

Memory search works across the current session. Cross-session search requires
`memory.recall.cross_session: true` in `companion.yaml` (experimental).

---

## Sessions

Each conversation is a session. Sessions persist in SQLite — they survive server restarts.

**Create via TUI:** press `n`

**Create via API:**
```bash
curl -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"My project","goal":"Build a REST API","mode":"local"}'
```

**Archive old sessions** (keeps them searchable, removes from active list):
```bash
curl -X PATCH http://localhost:3000/sessions/SESSION_ID \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"status":"archived"}'
```

---

## Skills

Skills are YAML-defined tools that extend what agents can do. They live in `./skills/`.

**List active skills** in TUI: `Tab` to Capabilities pane, press `3`.

**Add a skill:** create `skills/my-skill/skill.yaml`. The server picks it up on next start.

Example — a skill to check Companion's own health:

```yaml
name: system-health
version: "1.0.0"
description: "Check system resource usage"
tags: [system, monitoring]

tools:
  - name: check_memory
    description: "Show memory usage"
    parameters: {}
    script: |
      free -h
```

Arguments to skills are passed as environment variables (`COMPANION_ARG_PARAM`), never
interpolated into the script string — safe against prompt injection.

---

## Security

### Authentication

Set `COMPANION_SECRET` in `.env`. All HTTP and WebSocket requests require:
```
Authorization: Bearer YOUR_SECRET
```

Leave blank to disable auth (local development only).

### Sandbox

Shell commands run in Docker if available (`companion-sandbox:latest` image).
Without Docker, commands run directly in the working directory.

To build the sandbox image:
```bash
docker build -t companion-sandbox:latest docker/
```

Without the image, shell tools run without network isolation. Do not expose
the server to untrusted networks without Docker.

### File access

File tools (`read_file`, `write_file`, `list_dir`) are restricted to paths within
the configured working directory. Path traversal (`../../../etc/passwd`) is blocked.

---

## API Reference

All requests require `Authorization: Bearer YOUR_SECRET` unless `COMPANION_SECRET` is blank.

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions` | List all sessions |
| `POST` | `/sessions` | Create session. Body: `{title, goal, mode}` |
| `GET` | `/sessions/:id` | Get session |
| `PATCH` | `/sessions/:id` | Update title, mode, status |
| `DELETE` | `/sessions/:id` | Delete session and messages |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions/:id/messages` | List messages. Query: `?limit=N` |
| `POST` | `/sessions/:id/messages` | Send message. Body: `{content, stream?, working_dir?}` |

**Streaming response** (`stream: true`): returns `text/event-stream`. Events:

```
data: {"type":"thought","agent":"engineer","text":"..."}
data: {"type":"tool_start","tool":"run_shell","agent":"engineer"}
data: {"type":"tool_end","tool":"run_shell","duration_ms":47}
data: {"type":"text","text":"The system load is..."}
```

**Non-streaming** (`stream: false`, default): returns 202 immediately. Pick up the
response via WebSocket or by polling `/sessions/:id/messages`.

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{"ok":true}` |
| `GET` | `/capabilities` | Lists all tools, agents, and loaded skills |
| `GET` | `/sessions/:id/blackboard` | Show internal agent state for a session |

### WebSocket

```
WS ws://localhost:3000/ws?session=SESSION_ID&token=YOUR_SECRET
```

Events received: `connected`, `sync_state`, `agent_start`, `agent_thought`,
`tool_start`, `tool_end`, `agent_end`, `orchestrator_decision`, `message`, `error`.

To switch which session you're subscribed to:
```json
{"type":"subscribe","session_id":"NEW_SESSION_ID"}
```

---

## Troubleshooting

### "Ollama not reachable"
```bash
ollama serve        # start Ollama
# or on macOS, check menu bar — Ollama icon should be there
```

### "model not found — run ollama pull"
```bash
bun run pull        # pulls all models in companion.yaml
# or directly:
ollama pull qwen2.5:3b
```

### TUI shows spinner but no response
Press `Esc` to abort. The 120-second timeout will also clear it automatically.
Check server logs for the error.

### "ConcurrencyError" in logs
Normal under high concurrency — two requests updated the same session simultaneously.
The second write is discarded and logged. Not a data loss issue.

### Port 3000 in use
```bash
COMPANION_PORT=3001 bun run server
```

Or change `server.port` in `companion.yaml`.


# Companion — Developer Guide

Architecture, internals, extension points, and contribution notes.

---

## Stack

| Concern | Technology |
|---------|-----------|
| Runtime | Bun ≥ 1.1.0 — all I/O uses `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.serve` |
| Monorepo | Bun workspaces + Turbo |
| Database | `bun:sqlite` (built-in) — WAL mode, FTS5, OCC |
| Vector store | sqlite-vec C extension with JS cosine fallback |
| HTTP + WS | `Bun.serve()` — no framework |
| TUI | Ink + React |
| Config | YAML + Zod |
| Lint / format | Biome |

No Node.js APIs. `node:path` and `node:fs/promises` appear in two places — Bun
implements these natively, they have no npm dependency.

---

## Repository layout

```
packages/
  config/     Zod schema, YAML loader, env interpolation, ConfigStore
  core/       Blackboard, EventBus, Logger, branded IDs, Result<T,E>
  db/         SQLite driver (bun:sqlite), OCC, FTS5, row mappers
  llm/        LLMClient — OpenAI wire format, Gemini, streaming, ReAct
  memory/     VectorStore, SlidingWindow, ContextBuilder
  tools/      ToolRegistry, built-in tools, SandboxExecutor
  skills/     YAML skill loader, COMPANION_ARG_* injection
  agents/     SessionProcessor (orchestrator), AgentRunner (ReAct loop)

apps/
  server/     Bun.serve HTTP+WS, SSE streaming, startup health check
  tui/        Ink terminal UI

scripts/
  pull.ts     Pulls all Ollama models defined in companion.yaml

skills/       Built-in skill definitions (bash, file-edit, database)
docs/         This guide and usage examples
```

---

## Package dependency graph

```
config
  └── core
        ├── db
        │     ├── llm
        │     │     └── memory
        │     │           └── tools
        │     │                 └── skills
        │     │                       └── agents
        │     │                             ├── server (app)
        │     │                             └── tui    (app)
        │     └── (direct)
        └── (direct)
```

Turbo respects this via `"dependsOn": ["^build"]`. Run `bun x turbo run build` to
build in dependency order.

---

## Core concepts

### Blackboard

`packages/core/src/index.ts` — `Blackboard` class

The shared state for a session. Agents read from and write to it via the orchestrator.
Never mutated concurrently — orchestrator dispatches one agent at a time.

```typescript
interface BlackboardData {
  goal:         string;
  observations: string[];       // agent outputs, last 5 shown in summary
  decisions:    Decision[];     // orchestrator routing log, last 6 shown
  rejections:   Rejection[];    // NEVER sliced — dead ends persist forever
  artifacts:    Record<string, unknown>;
  scratchpad:   Record<string, unknown>;
}
```

**Rejection list is permanent by design.** The orchestrator must never retry a
dead end. If the engineer failed 3 times with the same approach, that history
must be visible on round 10.

**OCC (Optimistic Concurrency Control):** the `sessions` table has a `version` column.
`db.sessions.update()` accepts `expected_version`. If the row was updated by another
request since it was read, `ConcurrencyError` is thrown. The server catches this,
logs a warning, and the blackboard write is skipped — the message is still saved.

### EventBus

`packages/core/src/index.ts` — singleton `bus`

All internal events flow through this. The server subscribes with `bus.on("*", ...)` and
broadcasts to WebSocket clients. Agents publish `agent_start`, `agent_thought`,
`tool_start`, `tool_end`, `agent_end`. The orchestrator publishes
`orchestrator_decision` and `orchestrator_verify`.

```typescript
bus.on("tool_end", (event) => {
  console.log(event.payload); // { tool: "run_shell", duration_ms: 47 }
});
```

### LLMClient

`packages/llm/src/index.ts`

Unified client over OpenAI wire format. Gemini is translated internally.

**Small model path (ReAct):** `modelSupportsTools()` returns `false` for small Ollama
models. The agent uses `json_mode: true` and the `buildReActPrompt()` template:

```json
{"thought":"why","tool":"tool_name","args":{"param":"value"}}
```

`parseReActResponse()` converts this to the internal `ChatMessage` format with `tool_calls`.
If the model returns invalid JSON, one recovery call is made with the broken output
shown inline. After that, the raw text is used as-is.

**Structured tool calls:** for capable models (GPT-4, Claude, Llama 3.1:70b, etc.),
standard OpenAI `tools` + `tool_choice: "auto"` is used.

**Gemini:** `toGeminiContents()` translates the full message history including
`tool_calls` / `tool` messages to Gemini's `functionCall` / `functionResponse` format.
System messages become `user/model` ping-pong pairs (Gemini REST API limitation).

### ContextBuilder

`packages/memory/src/index.ts`

**Pair-aware trim:** never removes an `assistant` message that has `tool_calls` without
also removing its `tool` result messages. Orphaned tool messages cause API errors on
every provider.

**Token counting:** counts `content.length + JSON.stringify(tool_calls).length` divided
by 4. Includes tool call JSON — not just the text — because large tool results dominate
context in code tasks.

**Single system block:** recall memories are fused into the existing system prompt.
No second `system` message. Multiple system messages are rejected or silently dropped
by some providers.

### SandboxExecutor

`packages/tools/src/index.ts`

If Docker is available, shell commands run in `companion-sandbox:latest` with:
- `--network=none` — no outbound connections
- `--label=managed_by=companion` — for zombie cleanup on restart
- Working dir mounted read-write

`cleanupZombies()` runs on server startup, killing any containers left from previous crashes.

Without Docker, commands run directly. Do not expose without Docker on untrusted networks.

---

## Configuration system

`packages/config/src/index.ts`

`companion.yaml` is loaded once at startup. Environment variables are interpolated:

```yaml
api_key: ${ANTHROPIC_API_KEY:-}
port:    ${COMPANION_PORT:-3000}
```

`${VAR:-default}` — use `VAR` if set, else `default`.
`${VAR}` — use `VAR`; empty string if unset.

**ConfigStore** holds the base config and per-session patches. Server calls
`store.get(sessionId)` to get effective config for a request — session-level
mode changes (1/2/3 in TUI) are stored here, not in the database.

**Adding a config field:**

1. Add to `ConfigSchema` in `packages/config/src/index.ts`
2. Add to `companion.yaml` with a sensible default
3. Access via `cfg.your.field` — Zod guarantees the type

---

## Adding an agent

In `companion.yaml`:

```yaml
agents:
  reviewer:
    model:       smart
    description: "Reviews code for correctness, security, and style."
    tools:       [read_file, search_history]
    reads_from:  [goal, observations, artifacts]
    writes_to:   [observations]
    max_turns:   4
```

That's it. No code changes. The orchestrator can now route to `"reviewer"`.

The orchestrator prompt does not list available agents explicitly — it infers from
the goal. If you want it to reliably route to a new agent, add examples to
`buildOrchestratorPrompt()` in `packages/agents/src/index.ts`.

---

## Adding a tool (code)

In `packages/tools/src/index.ts`:

```typescript
const myTool: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name:        "my_tool",
      description: "Does something useful.",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "The input" },
        },
        required: ["input"],
      },
    },
  },
  handler: async (args, ctx) => {
    const input = String(args["input"] ?? "");
    // ctx.session_id, ctx.working_dir, ctx.db, ctx.cfg available
    return `Result: ${input}`;
  },
};
```

Register it in `createToolRegistry()`:
```typescript
registry.register(myTool);
```

Then add its name to whichever agents should have access in `companion.yaml`.

---

## Adding a skill (YAML)

Create `skills/my-skill/skill.yaml`:

```yaml
name: my-skill
version: "1.0.0"
description: "A custom skill"
tags: [custom]

tools:
  - name: my_command
    description: "Runs my custom command"
    parameters:
      target:
        type: string
        description: "What to target"
        required: true
    timeout: 30
    script: |
      echo "Target is: $COMPANION_ARG_TARGET"
```

Arguments arrive as `COMPANION_ARG_UPPERCASE_PARAM`. The script environment is
built from scratch — `PATH`, `HOME`, `TMPDIR`, `WORKING_DIR`, `SESSION_ID`, and
`COMPANION_ARG_*` only. Server secrets are never forwarded.

Restart the server to pick up new skills. Skills can also use `bun run -e`:

```yaml
script: |
  import { readdir } from "node:fs/promises";
  const files = await readdir(process.env.WORKING_DIR);
  console.log(files.join("\n"));
```

---

## Database schema

SQLite, WAL mode. Two tables:

```sql
sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  status        TEXT,      -- active | archived | summarised
  mode          TEXT,      -- local | balanced | cloud
  blackboard    TEXT,      -- JSON BlackboardData
  summary       TEXT,
  message_count INTEGER,
  version       INTEGER,   -- OCC — incremented on blackboard update
  created_at    TEXT,
  updated_at    TEXT
)

messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  role          TEXT,      -- user | assistant | system | tool
  content       TEXT,
  tool_calls    TEXT,      -- JSON array of OAIToolCall
  tool_call_id  TEXT,
  name          TEXT,
  tokens        INTEGER,
  created_at    TEXT
)
```

FTS5 virtual table `sessions_fts` indexes `title` and `summary`.
The trigger fires **only on `UPDATE OF title, summary`** — blackboard updates
(which happen on every agent tick) do not rebuild the FTS index.

---

## Testing

```bash
bun test                    # all packages
bun test packages/core      # single package
bun test --watch            # watch mode
```

Test files: `packages/*/src/index.test.ts`

Current coverage:
- `core`: Blackboard (serialisation, rejection grouping, dead end permanence), Result, branded IDs
- `db`: CRUD, OCC ConcurrencyError, cascade delete
- `memory`: SlidingWindow chunking, ContextBuilder pair-aware trim, token counting

When adding features, add tests in the same file as the implementation.

---

## Running Turbo

```bash
bun x turbo run test         # all tests in dependency order
bun x turbo run typecheck    # type check all packages
bun x turbo run build        # build all packages
```

Turbo caches task outputs in `.turbo/`. Delete it if you see stale results:
```bash
rm -rf .turbo
```

---

## Lint and format

```bash
bun run lint        # biome check — reports issues
bun run format      # biome format --write — fixes in place
```

Biome config: `biome.json`. Rules: recommended + `noUnusedVariables` warn + `noExplicitAny` warn.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPANION_SECRET` | `dev-secret` | Bearer token for all API requests |
| `COMPANION_PORT` | `3000` | Server port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GEMINI_API_KEY` | — | Gemini API key |
| `DATABASE_URL` | — | Postgres URL (leave blank for SQLite) |

All consumed via `${VAR:-default}` in `companion.yaml`, not directly in code.
Add new variables to `.env.example` and the interpolation in `companion.yaml`.

---

## Known limitations

- **Cross-session memory** is not implemented. `recall.cross_session: true` in config
  has no effect — the vector search is always scoped to the current session.
- **Summarisation** triggers correctly but the summary is not fed back into context
  for the current request — only shown in the TUI session list.
- **Postgres driver** is declared in `packages/db/package.json` but `createPostgresDB()`
  is not implemented — the `createDB()` factory throws for `driver: postgres`.
- **`companion-sandbox` Docker image** has no `Dockerfile` in `docker/` — the directory
  exists but is empty. Shell tools fall back to direct execution.