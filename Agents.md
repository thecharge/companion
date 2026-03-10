# Agents.md

## Purpose

This file defines practical prerequisites and working rules for contributors and coding agents working in this repository.

## Development Prerequisites

1. OS: Linux or macOS recommended.
2. Bun: `>= 1.1.x`.
3. Node-compatible toolchain in PATH.
4. Python 3.x (used by helper scripts/tests).
5. Ollama running locally for local model workflows.
6. Optional container runtime for sandboxed tool execution:
- Docker
- Podman
- nerdctl

## Initial Setup

```bash
bun install
cp .env.example .env
bun run pull
ollama pull nomic-embed-text:latest
ollama pull qwen3:1.7b
```

## Daily Commands

Run server:

```bash
bun run server
```

Run TUI:

```bash
bun run tui
```

Quality gates:

```bash
bun run lint
bun run typecheck
bun run test
```

## Integration Prerequisites

For Slack and Telegram development/testing, configure `.env`:

- Slack:
- `SLACK_ENABLED=true`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- optional `SLACK_REQUIRED_PASSPHRASE`
- Telegram:
- `TELEGRAM_ENABLED=true`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET_TOKEN`
- optional `TELEGRAM_REQUIRED_PASSPHRASE`

For production-like hardening, also configure trusted IDs in `companion.yaml`:
- Slack: `trusted_user_ids`, `trusted_channel_ids`, `trusted_team_ids`
- Telegram: `trusted_user_ids`, `trusted_chat_ids`

Webhook usage (required for real-world testing):

1. Start server: `bun run server`
2. Expose server publicly via HTTPS tunnel (cloudflared/ngrok).
3. Register provider webhooks to:
- `https://<public-host>/integrations/slack/events`
- `https://<public-host>/integrations/telegram/webhook`
4. Verify provider registration:
- Slack Event Subscriptions shows URL verified.
- Telegram `getWebhookInfo` shows `ok: true` and no `last_error_message`.
5. Send test message from trusted sender with passphrase prefix when enabled.

Detailed runbook:
- `Docs/INTEGRATIONS_GUIDE.md`

Required telemetry endpoints:
- `GET /integrations/telemetry/config`
- `GET /integrations/telemetry/stats`

Smoke validation command:
- `bun run webhook:smoke`

## Sandbox Prerequisites

If you need containerized tool execution:

1. Build sandbox image:

```bash
docker build -t companion-sandbox:latest docker/sandbox
```

2. Set runtime:

```bash
export COMPANION_SANDBOX_RUNTIME=docker
```

3. Prefer no direct fallback in production configs:
- `sandbox.allow_direct_fallback: false`

## Working Conventions

1. Keep orchestration policy in YAML (`companion.yaml`), not hardcoded in agents.
2. Keep `apps/server/src/index.ts` thin; place logic in dedicated modules.
3. Add tests for behavior changes in touched packages.
4. Preserve strict security checks on integration webhooks.
5. Prefer deterministic proofs for runtime claims.

## Required Skills And Approach

When implementing or refactoring functionality, apply this package-wide approach:

1. Start from the architecture contract in `Docs/ARCHITECTURE_PATTERNS.md`.
2. Add or update `Strategy`, `Adapter`, `Repository`, `Facade`, and `Factory` boundaries where applicable.
3. Remove hardcoded strings and duplicate literals by introducing typed constants.
4. Add/extend tests for each extracted seam (strategy routing, repository behavior, factory wiring).
5. Keep app entrypoints thin (`apps/server/src/index.ts`, `apps/tui/src/App.tsx`).

Skills and capabilities contributors/agents should actively use:

1. `file-edit`: safe structured edits with minimal blast radius.
2. `skill-factory`: repeatable generation of factory-backed modules.
3. `subagent-coordination`: decomposing large cross-package refactors.
4. `provider-readiness`: provider integration checks and safety checks.
5. `compliance-readiness`: traceability and deterministic verification evidence.

## Before Opening PRs

Run:

```bash
bun run lint && bun run typecheck && bun run test
```

If integrations changed, also verify:

1. Slack signature/token validation behavior.
2. Telegram secret-token behavior.
3. Trusted sender gating behavior.
4. Passphrase gate behavior when configured.
