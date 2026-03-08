# Companion

Production-oriented, local-first AI companion built as a Bun + Turbo monorepo.

> Code Name: Titan

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
- Usage guide: `Docs/USAGE_GUIDE.md`
- Development guide: `Docs/DEVELOPMENT_GUIDE.md`

## Prerequisites
- Python 3.x
- Bun `>= 1.1.0`
- Ollama `>= 0.17.x` for local models
- Optional cloud key(s) for non-local mode (Anthropic configured by default)

## Quickstart

```bash
cp .env.example .env
# edit .env as needed

bun install
bun run pull      # pulls default local model
ollama pull nomic-embed-text:latest 
ollama pull qwen3:1.7b
```

Run services in two terminals:

```bash
bun run server
bun run tui
```

TUI working directory control:
- Type `/wd /absolute/path` in the TUI input to set where tools generate/edit code.
- Type `/wd` to print the currently active working directory.

## Operating Modes

Configured in `companion.yaml`:

- `local`: fully local model routing
- `balanced`: mixed local/cloud
- `cloud`: cloud-first for maximum capability

Mode behavior is policy-based, not provider-biased:
- `local` uses local aliases only.
- `balanced` uses hybrid alias remapping (local + cloud where configured).
- `cloud` prefers cloud aliases and falls back only when missing config.
- If cloud credentials fail at runtime (401/403), Companion falls back to `local` alias for continuity.

Provider-switch guarantee:
- Cloud aliases are config-driven and can point to Anthropic, OpenAI, Gemini, or any supported provider.
- Orchestration logic does not hardcode a specific cloud vendor.
- Runtime auth fallback is applied on provider auth errors so a bad cloud key does not hard-stop a session.

Set default mode under:

```yaml
mode:
  default: balanced
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

## Self-Improvement Loop

Companion can now propose acquiring a new skill when it detects repeated missing capability.

Flow:
1. Orchestrator evaluates whether existing registered tools/skills can solve the task.
2. If not, it asks for confirmation to acquire a new skill.
3. On `yes`, Companion scaffolds `skills/<new-skill>/skill.yaml`.
4. The new skill is loaded, registered, and made available to worker agents in the same running session.
5. On `no`, proposal is cancelled and normal execution continues.

Skill tooling included:
- `skill_of_skills`: recommends matching skills for a task.
- `create_skill_template`: scaffolds a new skill from parameters.

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

End-to-end verification matrix:
- Baseline gates: `bun run lint && bun run typecheck && bun run test`
- Mode remapping and loop tests: `bun --cwd packages/agents run test`
- Runtime health (server): `curl -s -H 'Authorization: Bearer dev-secret' http://localhost:3000/health`

Lint policy note:
- `biome.json` disables `complexity.useLiteralKeys` and `style.noNonNullAssertion` to keep lint actionable for this codebase while preserving strict compile and test gates.

## Deployment

### Self-hosted (Docker)

Use files under `docker/` and configure secrets via env vars.

Sandbox runtime behavior:
- If a container runtime is available but sandbox image is missing, Companion now falls back to direct host execution when `sandbox.allow_direct_fallback: true`.
- Build image for full isolation: `podman build -t companion-sandbox:latest docker/sandbox` (or Docker equivalent).

### Binary vs Container

Recommendation:
- Keep container-first for enterprise compliance, patching, and SBOM workflows
- Optionally add separate binaries later (`companion-server`, `companion-tui`) for developer UX

Detailed tradeoffs: `Docs/ROAST.md`.

## License

MIT (see `LICENSE`).
