# Production Roadmap

## Phase 0: Stabilize Build (Immediate)

Status: completed in current pass.

1. Fix package type errors.
- Completed.

2. Enforce CI gates.
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- Required checks for PR merge.

3. Expand tests for app boundaries.
- Server route contract tests.
- TUI integration smoke tests against mock server.
- Baseline smoke tests added for previously untested workspaces.

## Phase 1: Reliability and Guardrails

1. Add request IDs and structured logs.
2. Add retries/timeouts/circuit-breakers around provider calls.
3. Add per-tool allowlists and sandbox policy profiles.
4. Add explicit mode transition rules (local/balanced/cloud).

## Phase 2: Enterprise Controls

1. Introduce RBAC and tenant scoping.
2. Add immutable audit events.
3. Add secret rotation workflows.
4. Integrate SAST/DAST/dependency scanning.

## Phase 3: Distribution Strategy

1. Keep container-first for enterprise deployments.
2. Add optional binaries:
- `companion-server`
- `companion-tui`
3. Produce SBOM and signed releases for both container and binary artifacts.

## Suggested Monorepo Fragmentation Targets

1. Move server HTTP handlers into `apps/server/src/http/*`.
2. Move WS/session task state into `apps/server/src/ws/*`.
3. Move provider readiness probes into `packages/llm` health module.
4. Split `packages/llm/src/index.ts` by provider adapter.
5. Split `packages/tools/src/index.ts` by tool domain.

## Delivery Definition of Done

1. Zero type errors across workspaces.
2. Zero high/critical vulnerabilities in dependencies.
3. Test coverage target agreed and enforced.
4. Reproducible release artifact with changelog and rollback notes.
