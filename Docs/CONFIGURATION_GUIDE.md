# Configuration Guide

## File Layout

Primary config file: `companion.yaml`

Optional decomposition:
- `agents_dir: ./agents` to load agent YAML fragments from a folder.
- Working directory overrides (nearest parent wins):
  - `companion.override.yaml`
  - `companion.override.yml`
  - `.companion/companion.yaml`

## Core Sections

- `server`: bind host/port and API secret.
- `db`: sqlite/postgres storage backend.
- `vector`: embedding backend and dimensions.
- `models`: provider aliases used by orchestrator/agents.
- `orchestrator`: routing model and workflow tracks.
- `agents`: per-agent model, tools, and turn limits.
- `memory`: context window and summarization behavior.
- `mode`: local/balanced/cloud presets.
- `integrations`: Slack/Telegram bot settings.
- `tools`: per-tool runtime limits.
- `sandbox`: shell/test isolation strategy.

## Track Configuration

Define custom tracks in:

```yaml
orchestrator:
  workflow_tracks:
    product_delivery:
      triggers: [prd, roadmap]
      stages: [planner, engineer, responder]
```

## Security Recommendations

- Set non-default `server.secret`.
- Use strict webhook validation secrets in integrations.
- Keep `sandbox.allow_direct_fallback: false` in production.
- Cap webhook message length and event rate.
- Use working-dir overrides to reduce privileges in sensitive repos.

## Environment Variables

Config supports `${ENV_VAR:-default}` interpolation.

Example:

```yaml
server:
  secret: ${COMPANION_SECRET:-dev-secret}
```

## Provider Credentials

Common key env vars:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GROK_API_KEY`

Copilot caveat:
- GitHub Copilot does not expose a standard static API key flow for generic server-side API usage.
- Prefer explicit vendor providers above for deterministic backend operation.

See full acquisition and proof steps:
- `Docs/PROVIDER_KEYS_GUIDE.md`

## Validation and Proof

```bash
bun run proof:runtime
bun run proof:providers
bun run proof:runtime -- --strict
bun run proof:providers -- --strict
```
