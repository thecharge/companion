# Development Guide

## Monorepo Structure

- `apps/server`: HTTP, WS, SSE runtime.
- `apps/tui`: terminal UX.
- `packages/agents`: orchestration and agent loop.
- `packages/tools`: built-in tools + sandbox.
- `packages/skills`: skill loader and registration.

## Prerequisite Matrix

Required:
- Bun >= 1.1.x
- Linux/macOS shell runtime

Required for local and hybrid workloads:
- Ollama running and reachable at configured `OLLAMA_BASE_URL`
- Pulled models for `models.local` and vector embedding model

Required for cloud and hybrid workloads:
- Valid provider API key(s) for configured cloud aliases
- Outbound HTTPS connectivity to provider endpoints

Provider routing note:
- Cloud aliases are provider-agnostic and can be remapped between Anthropic/OpenAI/Gemini via `companion.yaml`.
- Runtime auth failure fallback keeps sessions alive by dropping to local alias when cloud credentials are invalid.

Recommended for production:
- Container runtime pinned (`docker` or `podman`)
- `sandbox.allow_direct_fallback: false`
- Non-default `COMPANION_SECRET`

## Local Dev Workflow

```bash
bun install
bun run lint
bun run typecheck
bun run test
```

Install git hooks (automatically run on `bun install` via `prepare`):

```bash
bun run prepare
```

Pre-commit hook gates:
- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

Generate runtime and provider proof reports:

```bash
bun run proof:runtime
bun run proof:providers
```

Run strict proof gates (recommended for production branches):

```bash
bun run proof:runtime -- --strict
bun run proof:providers -- --strict
```

Credential sourcing and provider-proof mapping:
- `Docs/PROVIDER_KEYS_GUIDE.md`

Run only impacted packages:

```bash
bunx turbo run typecheck --filter=@companion/agents --filter=@companion/server
bunx turbo run test --filter=@companion/agents --filter=@companion/skills
```

Orchestration-level verification:

```bash
bun --cwd packages/agents run test
```

This suite validates:
- deterministic explicit skill proposal path,
- confirm/create/register loop,
- mode remapping (`local`/`balanced`/`cloud`),
- preservation of additional configured agents during remap.

Run full readiness gate:

```bash
bun run readiness
```

## Adding a New Built-in Tool

1. Add schema + handler in `packages/tools/src/index.ts`.
2. Register in `createToolRegistry`.
3. Add tests in `packages/tools/src/index.test.ts`.
4. Add docs/examples.

High-usage built-ins (recommended defaults):
- `repo_map`: fast repository topology snapshot.
- `search_code`: ripgrep-backed code discovery.
- `runtime_posture`: runtime hardening posture.
- `provider_matrix`: provider alias/auth readiness matrix.

## Adding a New Skill

1. Create `skills/<name>/skill.yaml`.
2. Define tool schema and script.
3. Add tool name to an agent in `companion.yaml`.
4. If created through the acquisition loop, it is loaded immediately; manual file additions are loaded on next startup.

Complex lane-oriented skills currently bundled:
- `prd-design` (`prd_outline`)
- `ops-control-plane` (`incident_triage`, `release_readiness`)
- `subagent-coordination` (`decomposition_plan`)

## Coding Guidelines

- Keep business logic in services/orchestration layers, not transport handlers.
- Prefer small functions with explicit input/output contracts.
- Avoid hardcoded policy strings when shared constants or config is available.
- Never hardcode base agent IDs in orchestration modules; configure role IDs via `orchestrator.roles` in `companion.yaml`.
- Keep workflow signals and route policy in YAML (`orchestrator.workflow_tracks`, `orchestrator.intent_routes`), not inside function bodies.
- Use early returns for guard conditions and error paths.
- Use block-style guard returns in orchestrator/control-flow paths for readability.
- Prefer `export const ... = async (...) => { ... }` for module-level async helpers.
- Add tests for any new workflow branch, tool registration, or config remap behavior.
- Keep app-layer files under project limits and split by domain concern.

Reference standards:
- `Docs/ENGINEERING_STANDARDS.md`

## Branch and Commit Guidelines

- Branch naming: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`.
- Commit style: imperative, scoped summary and concise body.
- Include evidence in PRs: lint/typecheck/test/proof outputs.
- Require issue template linkage for bugs/features/security changes.

## VS Code Standards

- Workspace settings in `.vscode/settings.json` enforce:
	- format on save,
	- Biome as default formatter,
	- organize imports and fix-all on save,
	- clean newline/whitespace defaults.
- Recommended extensions in `.vscode/extensions.json`.

## Orchestration Tracks

Workflow tracks are config-driven via `orchestrator.workflow_tracks` in `companion.yaml`:
- `triggers`: intent keywords
- `stages`: ordered agent list

Runtime implementation:
- detection and plan assembly: `packages/agents/src/workflow-tracks.ts`
- execution loop: `packages/agents/src/index.ts`
- policy/signal config: `companion.yaml` (`orchestrator.roles`, `orchestrator.intent_routes`, `orchestrator.workflow_tracks`)

Role and route strict validation:
- implemented in `packages/config/src/index.ts` (`ConfigSchema.superRefine`)

Default examples in root config:
- `product_delivery`: `planner -> prd_designer -> delivery_manager -> engineer -> responder`
- `operations`: `planner -> operations_commander -> analyst -> engineer -> responder`

## Deterministic Tool Mode

`SessionProcessor` supports direct JSON tool execution for deterministic API automation runs.

Accepted `content` shapes:
- `{"tool":"write_file","args":{...}}`
- `{"tool_calls":[{"tool":"...","args":{...}}, ...]}`
- `[ {"tool":"...","args":{...}} ]`

Implementation location:
- `packages/agents/src/direct-tool-execution.ts` and `packages/agents/src/index.ts`

Use this mode for reproducible smoke tests and integration proofs when LLM planning variance is undesirable.

## Folder-Specific Config Overrides

Companion can load nearest folder override files upward from `working_dir`:
- `companion.override.yaml`
- `companion.override.yml`
- `.companion/companion.yaml`

Resolution lives in `packages/config/src/index.ts` (`resolveWorkingDirConfig`) and is applied per message in `apps/server/src/services/session-message-service.ts`.

## Slack and Telegram Bot Adapters

Server-native webhook adapters (no separate SDK package):
- Slack: `POST /integrations/slack/events`
- Telegram: `POST /integrations/telegram/webhook`

Implementation: `apps/server/src/services/integration-bot-service.ts`.

## TUI Executable Workflow

Generate standalone binary:

```bash
bun run build:tui:exe
```

Install to user PATH (`~/.local/bin/companion` by default):

```bash
bun run install:cli
```

## Brownfield Integration Playbook

1. Set `working_dir` to existing repository root.
2. Limit toolset per agent to approved actions for that repo.
3. Start with read-only flows (`read_file`, `search_history`, `list_dir`) before enabling write/edit tools.
4. Enforce CI checks (`lint`, `typecheck`, `test`) on every generated change.

## Greenfield Project Playbook

1. Create new session with explicit goal and mode (`balanced` recommended).
2. Set TUI/API `working_dir` to target empty directory.
3. Ask for scaffold generation with tests and CI config from first iteration.
4. Use skill acquisition loop to add recurring capabilities as dedicated skills.

## Skill Acquisition Internals

- Proposal state is stored in blackboard scratchpad as `pending_skill_proposal`.
- Confirmation loop lives in `packages/agents/src/index.ts`.
- Skill scaffold generation helper lives in `packages/agents/src/skill-acquisition.ts`.

## Production Hardening Checklist

- Replace default secret.
- Pin sandbox runtime.
- Disable direct fallback in production.
- Enable signed artifacts, SBOM, and vulnerability scanning.
- Add centralized audit logging pipeline.

## GitHub Governance Files

- `.github/ISSUE_TEMPLATE/bug_report.yml` for regression/defect reports.
- `.github/ISSUE_TEMPLATE/feature_request.yml` for scoped feature proposals.
- `.github/ISSUE_TEMPLATE/security_request.yml` for private security intake.
- `.github/dependabot.yml` for free weekly dependency and action updates.
- `.github/workflows/ci.yml` for lint/typecheck/test enforcement.
- `.github/workflows/dependency-review.yml` for pull-request dependency risk checks.
- `.github/workflows/proof.yml` for readiness and provider proof automation.
