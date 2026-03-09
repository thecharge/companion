# Configuration Guide

This reference documents every supported configuration surface in Companion:
- static config in `companion.yaml`
- environment-variable interpolation used inside `companion.yaml`
- runtime-only environment variables consumed directly by server/TUI/skill runtime
- working-directory override files

## Sources and Precedence

Configuration is resolved in this order:

1. `companion.yaml` is loaded.
2. `${ENV_VAR:-fallback}` expressions inside YAML are interpolated.
3. If `agents_dir` is set, agent fragments are merged in.
4. Nearest working-directory override is merged (if present):
- `companion.override.yaml`
- `companion.override.yml`
- `.companion/companion.yaml`

## Global Pattern

Any YAML value can use this form:

```yaml
some_key: ${ENV_NAME:-default-value}
```

Meaning:
- if `ENV_NAME` exists, use it
- otherwise use `default-value`

## Server and API

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `server.host` | none by default | `0.0.0.0` | Network interface for the HTTP server bind. Use `0.0.0.0` for containerized/public bind, `127.0.0.1` for local-only bind. |
| `server.port` | `COMPANION_PORT` | `3000` | TCP port used by the Companion server. |
| `server.secret` | `COMPANION_SECRET` | `dev-secret` | Bearer token required for authenticated API access. Must be changed for production. |

## Database and Vector Store

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `db.driver` | none by default | `sqlite` | Primary metadata/session database backend. Allowed values: `sqlite`, `postgres`. |
| `db.sqlite.path` | none by default | `./data/companion.db` | SQLite file path for primary state when `db.driver=sqlite`. |
| `db.postgres.url` | `DATABASE_URL` | empty | Postgres DSN used when `db.driver=postgres`. |
| `vector.backend` | none by default | `sqlite-vec` | Embedding/vector search backend. Allowed values: `sqlite-vec`, `qdrant`. |
| `vector.qdrant.url` | none by default | `http://localhost:6333` (in default YAML) | Qdrant base URL when `vector.backend=qdrant`. |
| `vector.qdrant.collection` | none by default | `companion` (in default YAML) | Qdrant collection name for embeddings. |
| `vector.embedding.model` | none by default | `nomic-embed-text` | Embedding model alias/name used for memory indexing and recall. |
| `vector.embedding.dimensions` | none by default | `768` | Expected embedding vector size for index creation and query compatibility. |

## Models

`models` is a map of aliases (`local`, `smart`, `fast`, etc). Each alias has the same fields:

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `models.<alias>.provider` | none by default | required | Backend provider for that alias. Allowed values: `ollama`, `anthropic`, `openai`, `gemini`, `copilot`, `grok`. |
| `models.<alias>.model` | none by default | required | Model identifier passed to the provider SDK/API. |
| `models.<alias>.base_url` | often `OLLAMA_BASE_URL` for ollama aliases | optional | Custom endpoint URL for self-hosted/provider-compatible routing. |
| `models.<alias>.api_key` | often provider key env vars | optional | API token for cloud providers. Usually injected via env interpolation. |
| `models.<alias>.max_tokens` | none by default | `4096` | Max response token budget for that alias. |
| `models.<alias>.temperature` | none by default | `0.2` | Sampling temperature (0 = deterministic, higher = more varied). |

Common provider env vars used in default config:

| Env Var | Typical Usage |
| --- | --- |
| `OLLAMA_BASE_URL` | `models.<ollama_alias>.base_url` |
| `ANTHROPIC_API_KEY` | `models.<anthropic_alias>.api_key` |
| `OPENAI_API_KEY` | `models.<openai_alias>.api_key` |
| `GEMINI_API_KEY` | `models.<gemini_alias>.api_key` |
| `GROK_API_KEY` | `models.<grok_alias>.api_key` |
| `GITHUB_TOKEN` | Optional provider/tooling flows that use GitHub auth. |

## Orchestrator

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `orchestrator.model` | none by default | `local` | Model alias used by orchestration logic unless mode routing overrides it. |
| `orchestrator.max_rounds` | none by default | `10` (schema default) | Maximum orchestration planning/execution rounds before forced stop. |
| `orchestrator.verify_results` | none by default | `true` | Enables extra verification pass of intermediate outputs. |
| `orchestrator.roles.responder` | none by default | empty | Agent name responsible for final user-facing synthesis. Must exist under `agents`. |
| `orchestrator.roles.promoted_agents[]` | none by default | empty list | Agents elevated for broader participation in orchestration. |
| `orchestrator.roles.skill_worker_agents[]` | none by default | empty list | Agents allowed/preferred for skill execution workflows. |
| `orchestrator.workflow_tracks.<track>.triggers[]` | none by default | empty list | Trigger keywords/phrases that route user requests into a named workflow track. |
| `orchestrator.workflow_tracks.<track>.stages[]` | none by default | empty list | Ordered agent stage pipeline for that track. Each stage must reference an existing agent. |
| `orchestrator.intent_routes[].keywords[]` | none by default | empty list | Keyword matcher set for fine-grained intent routing. |
| `orchestrator.intent_routes[].required_tools[]` | none by default | empty list | Tool names required for this route to be considered valid. |
| `orchestrator.intent_routes[].preferred_agent` | none by default | optional | Agent name to prioritize when route matches. Must exist under `agents`. |

## Agents and Agent Fragments

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `agents.<name>.model` | none by default | required | Model alias for this specific agent. |
| `agents.<name>.description` | none by default | required | Role description used by orchestration prompts and audits. |
| `agents.<name>.tools[]` | none by default | empty list | Explicit allowlist of tools this agent can invoke. |
| `agents.<name>.reads_from[]` | none by default | empty list | Blackboard channels the agent can consume from. |
| `agents.<name>.writes_to[]` | none by default | empty list | Blackboard channels the agent can publish to. |
| `agents.<name>.max_turns` | none by default | `8` | Safety cap on turns for this agent in a single orchestration run. |
| `agents_dir` | none by default | unset | Optional directory containing extra `.yaml`/`.yml` agent definitions to merge into `agents`. |

## Memory Behavior

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `memory.context_window.max_messages` | none by default | `40` | Max number of recent messages retained in active prompt context. |
| `memory.context_window.max_tokens` | none by default | `8000` | Max token budget reserved for message window assembly. |
| `memory.sliding_window.chunk_size` | none by default | `2000` | Chunk size used for long-content segmentation in memory pipeline. |
| `memory.sliding_window.page_size` | none by default | `20` | Number of chunks/pages processed per memory page operation. |
| `memory.recall.top_k` | none by default | `5` | Number of top memory matches returned for retrieval. |
| `memory.recall.min_score` | none by default | `0.72` | Minimum similarity threshold for retrieval inclusion (0 to 1). |
| `memory.recall.cross_session` | none by default | `false` | Enables retrieval from other sessions, not just current session. |
| `memory.summarisation.enabled` | none by default | `true` | Enables automatic summary generation for long sessions. |
| `memory.summarisation.trigger_at_messages` | none by default | `60` | Message-count threshold that triggers summarization pass. |
| `memory.summarisation.model` | none by default | `fast` | Model alias used for summarization tasks. |

## Mode Presets

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `mode.default` | none by default | `local` | Default runtime mode used for request handling/routing policy. |
| `mode.presets.<name>.description` | none by default | required in each preset | Human-readable mode intent shown in docs/UI/logs. |

## Integrations (Slack and Telegram)

### Slack

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `integrations.slack.enabled` | `SLACK_ENABLED` | `false` | Enables Slack webhook endpoint handling. |
| `integrations.slack.bot_token` | `SLACK_BOT_TOKEN` | empty | Bot token for posting replies back to Slack channels. |
| `integrations.slack.signing_secret` | `SLACK_SIGNING_SECRET` | empty | Slack request-signing secret for webhook authenticity verification. |
| `integrations.slack.trusted_user_ids[]` | none by default | empty list | Allowed Slack sender user IDs. Empty means no user-level allowlist. |
| `integrations.slack.trusted_channel_ids[]` | none by default | empty list | Allowed Slack channel IDs. Empty means no channel-level allowlist. |
| `integrations.slack.trusted_team_ids[]` | none by default | empty list | Allowed Slack workspace/team IDs. Empty means no workspace-level allowlist. |
| `integrations.slack.required_passphrase` | `SLACK_REQUIRED_PASSPHRASE` | empty | Optional message-prefix passphrase gate (step-up control). |
| `integrations.slack.mode` | `SLACK_MODE` | unset | Optional mode override for Slack-originated sessions. |
| `integrations.slack.default_session_title` | none by default | `Slack Session` | Title prefix/default for sessions created by Slack webhook messages. |
| `integrations.slack.max_message_chars` | none by default | `2000` | Per-message character limit before guard/rejection behavior. |
| `integrations.slack.max_events_per_minute` | none by default | `30` | Sliding window ingress rate cap per Slack channel/session key. |

### Telegram

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `integrations.telegram.enabled` | `TELEGRAM_ENABLED` | `false` | Enables Telegram webhook endpoint handling. |
| `integrations.telegram.bot_token` | `TELEGRAM_BOT_TOKEN` | empty | Bot token for posting replies back to Telegram chats. |
| `integrations.telegram.secret_token` | `TELEGRAM_SECRET_TOKEN` | empty | Webhook secret token expected in `x-telegram-bot-api-secret-token`. |
| `integrations.telegram.trusted_user_ids[]` | none by default | empty list | Allowed Telegram sender user IDs. |
| `integrations.telegram.trusted_chat_ids[]` | none by default | empty list | Allowed Telegram chat IDs. |
| `integrations.telegram.required_passphrase` | `TELEGRAM_REQUIRED_PASSPHRASE` | empty | Optional passphrase prefix required for accepted messages. |
| `integrations.telegram.mode` | `TELEGRAM_MODE` | unset | Optional mode override for Telegram-originated sessions. |
| `integrations.telegram.default_session_title` | none by default | `Telegram Session` | Title prefix/default for sessions created by Telegram webhook messages. |
| `integrations.telegram.max_message_chars` | none by default | `2000` | Per-message character limit before guard/rejection behavior. |
| `integrations.telegram.max_events_per_minute` | none by default | `30` | Sliding window ingress rate cap per Telegram chat/session key. |

## Tool Runtime Overrides

`tools` is a map keyed by tool name.

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `tools.<tool>.image` | none by default | unset | Optional container image override for this specific tool. |
| `tools.<tool>.timeout_seconds` | none by default | `30` | Per-tool execution timeout in seconds. |
| `tools.<tool>.allow_network` | none by default | `false` | Allows outbound network access for that tool execution context. |

## Sandbox

| Config Path | Env Var (if used) | Default | Meaning |
| --- | --- | --- | --- |
| `sandbox.runtime` | `COMPANION_SANDBOX_RUNTIME` | `auto` | Execution mode for shell/tests: `auto`, `docker`, `podman`, `nerdctl`, or `direct`. |
| `sandbox.allow_direct_fallback` | none by default | `true` | If `runtime=auto` and no container runtime is found, permit host-direct execution instead of hard failure. |
| `sandbox.image` | none by default | `companion-sandbox:latest` | Default container image used for sandboxed tool execution. |
| `sandbox.network` | none by default | `none` | Container network mode: `none`, `host`, or `bridge`. |
| `sandbox.timeout_seconds` | none by default | `30` | Default timeout for `run_shell` operations. |
| `sandbox.tests_timeout_seconds` | none by default | `120` | Default timeout for `run_tests` operations. |

## Runtime-Only Environment Variables (Outside YAML)

These are consumed directly by code paths and are not primary schema keys.

| Env Var | Default | Where Used | Meaning |
| --- | --- | --- | --- |
| `COMPANION_AUDIT_LOG_PATH` | `./data/audit-events.ndjson` | server bootstrap | File path for append-only NDJSON audit event storage. |
| `NODE_ENV` | unset | startup checks | Enables production safety warnings when set to `production`. |
| `COMPANION_URL` | unset | TUI client | Full API base URL override for TUI; if set, it wins over host/port derivation. |
| `COMPANION_HOST` | unset | TUI client | Host override for TUI when `COMPANION_URL` is not set. |
| `COMPANION_PORT` | `3000` | server + TUI | Port override used by server bind and TUI URL derivation when explicit URL is absent. |
| `COMPANION_SECRET` | empty in TUI if missing | server + TUI | API bearer secret. TUI injects it into `Authorization` header. |
| `COMPANION_ARG_*` | per invocation | skills runtime | Argument-passing channel for skill tool executions (for example `COMPANION_ARG_QUERY`). |

## Recommended Minimum Production Posture

1. Set strong `server.secret` via `COMPANION_SECRET`.
2. Pin sandbox runtime (`docker` or `podman`) and set `sandbox.allow_direct_fallback: false`.
3. Configure explicit allowlists for Slack/Telegram before enabling either integration.
4. Keep passphrase gates enabled for externally reachable chat/webhook channels.
5. Keep timeouts and rate limits strict unless you have measured need to increase them.

## Validation and Proof Commands

```bash
bun run proof:runtime
bun run proof:providers
bun run proof:runtime -- --strict
bun run proof:providers -- --strict
```
