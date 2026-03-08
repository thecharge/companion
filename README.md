# Companion

Production-oriented, local-first AI companion built as a Bun + Turbo monorepo.

By Radoslav Sandov

Companion is designed to run in two realities:
- Local-first for privacy and zero cloud cost
- Hybrid/cloud-first for higher capability and team/enterprise deployment

## Current Status

The codebase is functional but still evolving. This repository now includes a concrete production roadmap, compliance readiness plan, security controls, and extensibility guides in `Docs/`.

- Architecture and roast: `Docs/ROAST.md`
- Delivery roadmap: `Docs/PRODUCTION_ROADMAP.md`
- Compliance readiness (SOC 2 / ISO 27001 / PCI DSS): `Docs/COMPLIANCE_READINESS.md`
- Security baseline: `Docs/SECURITY.md`
- Extensibility and pipelines: `Docs/EXTENSIBILITY_GUIDE.md`
- Real usage examples: `Docs/EXAMPLES.md`

## Prerequisites

- Bun `>= 1.1.0`
- Ollama `>= 0.17.x` for local models
- Optional cloud key(s) for non-local mode (Anthropic configured by default)

## Quickstart

```bash
cp .env.example .env
# edit .env as needed

bun install
bun run pull      # pulls default local model
```

Run services in two terminals:

```bash
bun run server
bun run tui
```

## Operating Modes

Configured in `companion.yaml`:

- `local`: fully local model routing
- `balanced`: mixed local/cloud
- `cloud`: cloud-first for maximum capability

Set default mode under:

```yaml
mode:
  default: local
```

## API Smoke Test

Create a session:

```bash
curl -s -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"ops","goal":"check system load"}'
```

Send a message:

```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"What is the current system load?","stream":true}'
```

Run a task in a specific folder (explicit `working_dir`):

```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "content":"Create a Bun + Hono todo app with SQLite and tests in this directory.",
    "working_dir":"/absolute/path/where/code-should-be-generated",
    "stream":true
  }'
```

More examples: `Docs/EXAMPLES.md`.

## Repository Layout

```text
apps/
  server/   HTTP + WS orchestration API
  tui/      Terminal UX client
packages/
  agents/   orchestration and agent loop
  config/   typed YAML config loader
  core/     shared domain types + event bus
  db/       persistence and migrations
  llm/      provider adapters
  memory/   vector memory and recall
  skills/   skill loading and registration
  tools/    tool registry and sandbox execution
```

## Production Notes

- TUI has been split into modular components for maintainability.
- Server now applies security response headers by default.
- Startup checks are centralized for sandbox/model readiness.
- Shared enum-like constants now exist in `packages/core` for key literals.

## Build, Test, Typecheck

```bash
bun run lint
bun run typecheck
bun run test
```

Current status:
- `lint`: passing
- `typecheck`: passing across all workspaces
- `test`: passing across all workspaces

Lint policy note:
- `biome.json` disables `complexity.useLiteralKeys` and `style.noNonNullAssertion` to keep lint actionable for this codebase while preserving strict compile and test gates.

## Deployment

### Self-hosted (Docker)

Use files under `docker/` and configure secrets via env vars.

### Binary vs Container

Recommendation:
- Keep container-first for enterprise compliance, patching, and SBOM workflows
- Optionally add separate binaries later (`companion-server`, `companion-tui`) for developer UX

Detailed tradeoffs: `Docs/ROAST.md`.

## License

MIT (see `LICENSE`).
