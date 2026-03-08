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
4. Restart the server to load the new skill.

## Runtime Safety Notes

- In production, pin `sandbox.runtime` to `docker` or `podman`.
- Set `sandbox.allow_direct_fallback: false` in production.
- Set a non-default `COMPANION_SECRET`.
