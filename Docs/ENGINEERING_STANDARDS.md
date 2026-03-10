# Engineering Standards

This document defines repository-wide standards for orchestration, configuration, formatting, and TUI behavior.

## Architecture Rules

- Do not hardcode base agent IDs (`analyst`, `engineer`, `responder`, etc.) in orchestration logic.
- Keep orchestration policy in YAML config, not code-level policy tables.
- Current policy source of truth: `companion.yaml` under `orchestrator.roles`, `orchestrator.intent_routes`, and `orchestrator.workflow_tracks`.
- New runtime features must be structured with explicit boundaries:
  - Strategy for provider/behavior selection.
  - Adapter for provider/protocol translation.
  - Repository for persistence and external I/O access.
  - Facade for app-layer orchestration entrypoints.
  - Factory for construction and dependency wiring.
- Avoid god-object files in apps and packages. Split stateful orchestration from transport/UI rendering.

## Configuration Placement

- Treat signal lists, workflow plans, and intent route policy as YAML configuration data.
- Keep runtime parsing/validation in `packages/config/src/index.ts`.
- Do not rebuild static policy arrays in function bodies.

## Code Style Rules

- Prefer exported const functions for module-level helpers:
  - `export const fn = async (...) => { ... }`
- Guard-return branches must use block form in critical flow control:
  - `if (condition) { return ...; }`
- Keep spacing readable around conditional blocks, especially in async methods.

## TUI UX Rules

- Loading states in major panes should be animated, not static text.
- Use braille-shift style frames for progressive loading indicators in pane-level status.
- Do not use dot/ellipsis loaders (`...`) or "thinking..." labels in status UI. Use explicit labels such as `processing`, `reasoning`, or `stream`.
- Operational telemetry must be visible to users in the TUI:
  - Audit events are surfaced in the Capabilities pane under the `Audit` tab.

## Audit Visibility

- Server audit events are persisted through `@companion/db` audit repository.
- Default behavior writes to the active database driver and mirrors NDJSON with size-based rotation (`data/audit-events.ndjson` by default).
- API endpoint: `GET /audit/events?limit=<n>`.
- TUI surfaces recent audit events so users can inspect activity without leaving the terminal.

## Persistence Boundary Rules

- Database interactions must be implemented in `packages/db`.
- App and feature packages must consume persistence via `@companion/db` repositories/factories, not direct `bun:sqlite` or ad-hoc driver calls.
- For runtime portability, driver selection must remain config-driven (`db.driver`) and validated by `bun run proof:db`.
- Schema changes must be delivered through `packages/db/src/migrations.ts` migration entries and tracked in `db_migrations`.

## Enforcement Checklist

Before merge:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test`
4. Confirm no new hardcoded base-agent literals were introduced in `packages/agents`.
5. Confirm policy updates were made in `companion.yaml` (`orchestrator.*`) instead of inline orchestration code.
