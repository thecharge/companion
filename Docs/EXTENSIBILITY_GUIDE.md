# Extensibility Guide

## Add a New Skill

1. Create a new `skill.yaml` under `skills/<name>/skill.yaml`.
2. Define metadata and tool mappings.
3. Restart server and verify skill appears in `/capabilities`.

## Add a New Tool

1. Implement tool in `packages/tools/src/index.ts` (recommended: split by domain file next).
2. Register in tool registry.
3. Add tests for success/failure/timeouts.
4. Update `companion.yaml` agent tool allowlists.

## Add a New Agent Pipeline

Examples you asked for:
- Management pipeline
- Product design pipeline
- Web browsing pipeline

Steps:
1. Define agent in `companion.yaml` with model, description, read/write scopes, max turns.
2. Add any required tools.
3. Update orchestrator strategy if specialized routing is needed.
4. Validate in local and cloud modes.

## Local-first and Non-local-first Profiles

Local-first profile:
- all agents + orchestrator use local alias
- sandbox network defaults to `none`

Non-local-first profile:
- orchestrator or specialist agents use cloud aliases
- strict outbound policy and audit logs enabled

## Guarded Copilot Usage Pattern

1. Require tests and typecheck before merge.
2. Require short design note for non-trivial AI-generated changes.
3. Require human approval for security-sensitive or infra changes.
