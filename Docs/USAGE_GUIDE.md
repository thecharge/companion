# Usage Guide

## Start Services

```bash
bun install
bun run pull
bun run server
bun run tui
```

## Session Modes

- `local`: local-only model aliases.
- `balanced`: hybrid alias routing for mixed workloads.
- `cloud`: cloud-preferred alias routing.

Runtime continuity rule:
- If cloud credentials return 401/403 during a run, Companion automatically falls back to local alias to keep the session usable.
- This applies regardless of whether cloud aliases map to Anthropic, OpenAI, or Gemini.

Set default in `companion.yaml`:

```yaml
mode:
  default: balanced
```

## TUI Commands

- `/wd /absolute/path` sets session working directory.
- `/wd` shows current working directory.
- `1`, `2`, `3` switch mode.
- `Esc` cancels active task.

## API Flow

1. Create session.
2. Post messages with optional `working_dir`.
3. Read SSE stream output and task events.

Mode validation quick checks:
- `local`: verify no cloud key is required and tasks complete.
- `balanced`: verify cloud path works when keys are valid, and falls back to local on auth error.
- `cloud`: verify cloud alias usage and expected fallback behavior when provider errors occur.

Orchestration validation quick checks:
- Router picks only configured agents; if an invalid target is produced, runtime falls back to a valid configured agent.
- Agent loop is bounded by `max_turns` and returns a terminal state (`done`, `max_turns`, `error`, or `cancelled`).

```bash
curl -s -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"demo","goal":"assist devops","mode":"balanced"}'
```

```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"summarize current service health","working_dir":"/abs/path","stream":true}'
```

## Skill Acquisition Loop

When Companion detects a reusable missing capability:

1. It proposes a new skill scaffold.
2. You respond `yes` or `no`.
3. On `yes`, a new file is generated under `skills/<skill-name>/skill.yaml`.
4. Skill is loaded and registered immediately in the same running session.

## Brownfield Usage Pattern

Use with existing repositories:
- Set `working_dir` to repo root.
- Ask first for analysis-only actions before write actions.
- Require generated patches to pass repo checks before merge.

## Greenfield Usage Pattern

Use with new repositories:
- Set `working_dir` to empty project folder.
- Ask for scaffold + tests + CI in first request.
- Add missing recurring capabilities via the skill acquisition confirmation loop.

## Runtime Safety Notes

- In production, pin `sandbox.runtime` to `docker` or `podman`.
- Set `sandbox.allow_direct_fallback: false` in production.
- Set a non-default `COMPANION_SECRET`.

## Slack and Telegram Usage

Webhook endpoints:
- Slack: `POST /integrations/slack/events`
- Telegram: `POST /integrations/telegram/webhook`

Quick validation:

```bash
curl -s -X POST http://localhost:3000/integrations/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"ok"}'
```

For production, always provide valid Slack signature headers and Telegram secret-token headers.

## Working Directory Override Usage

If `working_dir` is inside a project containing nearest override file (`companion.override.yaml`), that override is merged for that request/session execution path.

Example request with working_dir:

```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"run checks","working_dir":"/workspace/app"}'
```
