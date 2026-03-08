# Companion Production Roast

## Severity: Critical

1. Compliance controls are not yet auditable by default.
- SOC 2 / ISO / PCI readiness needs formalized controls, evidence collection, and policy docs.
- Docker-only deployment is not by itself compliance.

2. Monolithic app entrypoints were high risk for regressions.
- `apps/tui/src/index.tsx` and `apps/server/src/index.ts` concentrated too much behavior in single files.
- This increases onboarding cost, regression rate, and mean time to recovery.

## Severity: High

1. Local/non-local behavior is too implicit.
- Provider fallback and model readiness behavior is not strongly surfaced in UX and docs.

2. Hardcoded operational assumptions.
- Defaults (ports, secrets, model aliases) are practical for dev but weak for enterprise guardrails.

3. Security posture needed explicit baseline.
- Missing a project-level security control matrix and incident process.

## Severity: Medium

1. README was too narrative and not operator-friendly.
2. Extensibility guidance for adding pipelines/skills/tools was underspecified.
3. Binary delivery strategy was undefined.

## What Was Improved In This Pass

1. TUI modularization.
- Split into: `apps/tui/src/App.tsx`, `apps/tui/src/api.ts`, `apps/tui/src/constants.ts`, `apps/tui/src/types.ts`, and component files in `apps/tui/src/components/`.
- `apps/tui/src/index.tsx` is now a thin entrypoint.

2. Server hardening.
- Added response security headers via `apps/server/src/security.ts`.
- Added centralized startup checks in `apps/server/src/startup-checks.ts`.
- Reduced literal sprawl with `EventType`/`MessageRole` usage in server flow.

3. Shared enum-like constants.
- Added `SessionStatus`, `SessionMode`, `MessageRole`, and `EventType` constants in `packages/core/src/index.ts`.

4. Documentation uplift.
- Added enterprise-focused docs under `Docs/` with concrete roadmaps and examples.

5. Delivery gates are now green.
- `bun run lint` passes.
- `bun run typecheck` passes across all workspaces.
- `bun run test` passes across all workspaces with baseline tests added for previously untested packages/apps.

6. Runtime fit-for-use fixes added after real-world failures.
- Sandbox now checks runtime image availability and falls back to direct execution when allowed, avoiding repeated podman/docker registry failures for missing local images.
- Session mode now affects model routing (`local`, `balanced`, `cloud`) instead of only changing labels.
- Vector memory is now actually persisted and recalled through server message flow.
- TUI now supports explicit per-session target path control via `/wd <path>` and sends `working_dir` on every request.

## Remaining Gaps Before Claiming Enterprise Grade

1. Formal threat model and secure SDLC process.
2. Secret management hardening (vault/KMS in non-local environments).
3. Authn/authz model beyond static API secret.
4. Audit logging and tamper-evident event retention.
5. CI/CD with signed artifacts + SBOM + vulnerability scanning.
