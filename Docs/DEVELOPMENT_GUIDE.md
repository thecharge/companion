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

Run only impacted packages:

```bash
bunx turbo run typecheck --filter=@companion/agents --filter=@companion/server
bunx turbo run test --filter=@companion/agents --filter=@companion/skills
```

Run full readiness gate:

```bash
bun run readiness
```

## Adding a New Built-in Tool

1. Add schema + handler in `packages/tools/src/index.ts`.
2. Register in `createToolRegistry`.
3. Add tests in `packages/tools/src/index.test.ts`.
4. Add docs/examples.

## Adding a New Skill

1. Create `skills/<name>/skill.yaml`.
2. Define tool schema and script.
3. Add tool name to an agent in `companion.yaml`.
4. Restart server so `loadSkillsDir` picks it up.

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
