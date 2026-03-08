# Development Guide

## Monorepo Structure

- `apps/server`: HTTP, WS, SSE runtime.
- `apps/tui`: terminal UX.
- `packages/agents`: orchestration and agent loop.
- `packages/tools`: built-in tools + sandbox.
- `packages/skills`: skill loader and registration.

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
