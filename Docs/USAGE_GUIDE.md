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
- `r` reopens the currently selected session and reconnects chat stream.
- `v` toggles status details (`agent/tool` log and audit tail) in Chat pane.
- In Capabilities pane: `1/2/3/4` or `a/t/s/u` switch tabs (`agents/tools/skills/audit`).
- In Capabilities pane: `j/k` or arrows scroll; `PgUp/PgDn` page; `g/G` jump top/bottom.
- `Esc` cancels active task.

Capabilities pane behavior:
- Loading now uses braille-shift animation rather than static text.
- `Audit` tab shows recent server audit events from `/audit/events`.

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

## Deterministic Tool Invocation (JSON)

For reproducible automation or verification runs, you can send direct tool calls as JSON in `content`.
This bypasses model planning and executes tools in-order with the request `working_dir`.

Single tool call:

```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "content":"{\"tool\":\"write_file\",\"args\":{\"path\":\"proove.sh\",\"content\":\"#!/usr/bin/env bash\\necho hello\\n\"}}",
    "working_dir":"/tmp",
    "stream":false
  }'
```

Multiple tool calls:

```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "content":"{\"tool_calls\":[{\"tool\":\"write_file\",\"args\":{\"path\":\"proove.sh\",\"content\":\"#!/usr/bin/env bash\\necho hello\\n\"}},{\"tool\":\"run_shell\",\"args\":{\"command\":\"chmod +x proove.sh\"}}]}",
    "working_dir":"/tmp",
    "stream":false
  }'
```

Notes:
- Paths remain sandbox/path-safety constrained to `working_dir`.
- Tool names and args must match registered tool schemas.

## End-to-End Proof Script

Use this single script to prove Companion can create:
- `/tmp/proove.sh`
- `/tmp/proove_vars.py`
- `skills/tmp-proof-skill-direct/skill.yaml`

```bash
cat >/tmp/companion-proof.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# 1) Start server with explicit auth and custom port
COMPANION_PORT=3212 COMPANION_SECRET=proof2-secret bun run server >/tmp/companion-proof-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true' EXIT
sleep 2

API=http://localhost:3212
AUTH='Authorization: Bearer proof2-secret'

# 2) Create session (local mode for deterministic local execution)
SID=$(curl -sS -X POST "$API/sessions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"Deterministic Proof","goal":"prove direct tools","mode":"local"}' \
  | bun -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.session.id)')

echo "SESSION_ID=$SID"

# 3) Create /tmp/proove.sh (write_file + chmod via shell)
CONTENT1='{"tool_calls":[{"tool":"write_file","args":{"path":"proove.sh","content":"#!/usr/bin/env bash\necho HOSTNAME=$HOSTNAME\necho USER=$USER\necho PWD=$PWD\necho DATE=$(date -Iseconds)\necho UPTIME=$(uptime)\n"}},{"tool":"run_shell","args":{"command":"chmod +x proove.sh"}}]}'
PAY1=$(printf '%s' "$CONTENT1" | bun -e 'const fs=require("fs");const c=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify({content:c,working_dir:"/tmp",stream:false}))')
curl -sS -X POST "$API/sessions/$SID/messages" -H "$AUTH" -H 'Content-Type: application/json' -d "$PAY1" >/dev/null

# 4) Create /tmp/proove_vars.py
CONTENT2='{"tool":"write_file","args":{"path":"proove_vars.py","content":"import os,sys\nprint(\"python\", sys.version.split()[0])\nprint(\"cwd\", os.getcwd())\nfor k in [\"USER\",\"HOME\",\"SHELL\"]:\n    print(k, os.getenv(k, \"\"))\n"}}'
PAY2=$(printf '%s' "$CONTENT2" | bun -e 'const fs=require("fs");const c=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify({content:c,working_dir:"/tmp",stream:false}))')
curl -sS -X POST "$API/sessions/$SID/messages" -H "$AUTH" -H 'Content-Type: application/json' -d "$PAY2" >/dev/null

# 5) Create skill scaffold via create_skill_template
CONTENT3='{"tool":"create_skill_template","args":{"skill_name":"tmp-proof-skill-direct","description":"Direct proof skill scaffold","tool_name":"proof_echo","arg_name":"line"}}'
PAY3=$(printf '%s' "$CONTENT3" | bun -e 'const fs=require("fs");const c=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify({content:c,working_dir:"/home/thecharge/workspace/companion",stream:false}))')
curl -sS -X POST "$API/sessions/$SID/messages" -H "$AUTH" -H 'Content-Type: application/json' -d "$PAY3" >/dev/null

sleep 2

echo '--- assistant outputs ---'
curl -sS "$API/sessions/$SID/messages?limit=100" -H "$AUTH" \
  | bun -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));for (const m of (j.messages||[]).filter(x=>x.role==="assistant")){console.log("---");console.log(m.content)}'

echo '--- verify /tmp files ---'
ls -l /tmp/proove.sh /tmp/proove_vars.py

echo '--- /tmp/proove.sh ---'
sed -n '1,120p' /tmp/proove.sh

echo '--- /tmp/proove_vars.py ---'
sed -n '1,120p' /tmp/proove_vars.py

echo '--- run artifacts ---'
bash /tmp/proove.sh | sed -n '1,20p'
python3 /tmp/proove_vars.py | sed -n '1,20p'

echo '--- verify skill scaffold ---'
find /home/thecharge/workspace/companion/skills/tmp-proof-skill-direct -maxdepth 2 -type f -print
sed -n '1,200p' /home/thecharge/workspace/companion/skills/tmp-proof-skill-direct/skill.yaml
EOF

bash /tmp/companion-proof.sh
```

Expected result:
- The two `/tmp` files exist and print runtime/env values.
- `skills/tmp-proof-skill-direct/skill.yaml` exists with tool `proof_echo`.

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

Sandbox image build commands:

```bash
docker build -t companion-sandbox:latest docker/sandbox
# or
podman build -t companion-sandbox:latest docker/sandbox
# or
nerdctl build -t companion-sandbox:latest docker/sandbox
```

Run server with strict docker sandbox mode:

```bash
COMPANION_SANDBOX_RUNTIME=docker bun run server
```

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
