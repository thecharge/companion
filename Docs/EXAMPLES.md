# Real Usage Examples

## 1) System Load and Weather

Create a session:

```bash
SESSION_ID=$(curl -s -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"title":"ops","goal":"ops checks"}' | jq -r '.session.id')
```

Ask system load:

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"What is the current system load?"}'
```

Ask weather (requires enabled weather/web tool in your profile):

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"What is the weather in Sofia right now?"}'
```

## 2) Operate With Tools and Skills

Example prompt:

```text
Inspect /var/log for the last 100 lines of errors, summarize root cause candidates,
and suggest safe next actions.
```

Expected behavior:
- Orchestrator routes to `engineer` and/or `analyst`
- tool calls execute via sandbox
- responder synthesizes final plan

## 3) Generate a Small Project at a Target Path

Example prompt:

```text
Create a Bun + Hono todo app with SQLite and tests in /tmp/demo-todo.
Include routes, schema, migrations, and test commands.
```

Guardrails to require:
- explicit target path
- no destructive commands outside target
- generated README with run/test instructions

## 4) Extensibility for End Users

To extend with your own workflow:
1. Add tools and skill definitions
2. Add new agents in `companion.yaml`
3. Add profile presets for local and cloud
4. Document examples and expected outputs
