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
```

## Run

```bash
# Server (port 3000 by default)
bun run apps/server/src/index.ts

# TUI (separate terminal)
bun run apps/tui/src/index.tsx
```

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
