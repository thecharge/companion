# Engineering Standards

This document defines repository-wide standards for orchestration, configuration, formatting, and TUI behavior.

## Architecture Rules

- Do not hardcode base agent IDs (`analyst`, `engineer`, `responder`, etc.) in orchestration logic.
- Use `packages/agents/src/agent-ids.ts` (`BaseAgent.*`) whenever referring to built-in lane IDs.
- Keep policy tables and signal lists in central config modules, not inline in lambda/function bodies.
- Current policy source of truth: `packages/agents/src/policy-config.ts`.

## Configuration Placement

- Treat signal lists, workflow plans, and intent route policy as configuration data.
- Keep configuration at module scope or dedicated config files.
- Do not rebuild static config arrays on every function invocation.

## Code Style Rules

- Prefer exported const functions for module-level helpers:
  - `export const fn = async (...) => { ... }`
- Guard-return branches must use block form in critical flow control:
  - `if (condition) { return ...; }`
- Keep spacing readable around conditional blocks, especially in async methods.

## TUI UX Rules

- Loading states in major panes should be animated, not static text.
- Use braille-shift style frames for progressive loading indicators in pane-level status.
- Operational telemetry must be visible to users in the TUI:
  - Audit events are surfaced in the Capabilities pane under the `Audit` tab.

## Audit Visibility

- Server audit events are persisted to NDJSON (`data/audit-events.ndjson` by default).
- API endpoint: `GET /audit/events?limit=<n>`.
- TUI surfaces recent audit events so users can inspect activity without leaving the terminal.

## Enforcement Checklist

Before merge:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test`
4. Confirm no new hardcoded base-agent literals were introduced in `packages/agents`.
5. Confirm policy updates were made in `policy-config.ts` instead of inline orchestration.
