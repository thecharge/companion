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
  -d '{"content":"What is the current system load?","working_dir":"/tmp"}'
```

Ask weather (requires enabled weather/web tool in your profile):

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"What is the weather in Sofia right now?","working_dir":"/tmp"}'
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

API example with explicit target folder:

```bash
TARGET="/absolute/path/to/new-project"

curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"Create a Bun + Hono todo app with SQLite and tests in this folder.\",\"working_dir\":\"$TARGET\",\"stream\":true}"
```

## 4) Extensibility for End Users

To extend with your own workflow:
1. Add tools and skill definitions
2. Add new agents in `companion.yaml`
3. Add profile presets for local and cloud
4. Document examples and expected outputs

## 5) Idempotent Create Session (Safe Retry)

```bash
KEY="session-create-001"

curl -s -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: $KEY" \
  -d '{"title":"idempotent-demo","goal":"prove safe retries"}'
```

Run the same command again with the same key and payload to receive the original response as replay.

## 6) Idempotent Message Send (Safe Retry)

```bash
MSG_KEY="message-$SESSION_ID-001"

curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -H "x-idempotency-key: $MSG_KEY" \
  -d '{"content":"Summarize current system posture","stream":false}'
```

## 7) Direct Skill Invocation (Single)

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool\":\"sql_workflow_guide\",\"args\":{\"task\":\"top customers by revenue\",\"dialect\":\"sqlite\"}}"}'
```

## 8) Direct Skill Invocation (Multiple)

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool_calls\":[{\"tool\":\"incident_triage\",\"args\":{\"service\":\"companion\",\"symptom\":\"5xx spike\"}},{\"tool\":\"release_readiness\",\"args\":{\"change_scope\":\"hotfix deploy\"}}]}"}'
```

## 9) Website Resource Research Skill

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool\":\"research_web_resource\",\"args\":{\"url\":\"https://modelcontextprotocol.io\",\"focus\":\"transport and server setup\"}}"}'
```

## 10) File Research Skill (Absolute Local Path)

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool\":\"research_file_source\",\"args\":{\"source\":\"/tmp/test.log\",\"source_type\":\"local\",\"question\":\"What is the primary failure pattern?\"}}","working_dir":"/tmp"}'
```

## 11) File Research Skill (Relative Uploaded Path in Working Dir)

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool\":\"research_file_source\",\"args\":{\"source\":\"uploads/customer-chat.txt\",\"source_type\":\"local\",\"question\":\"List user pain points\"}}","working_dir":"/absolute/project/path"}'
```

## 12) File Research Skill (Web Link)

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool\":\"research_file_source\",\"args\":{\"source\":\"https://example.com/spec.txt\",\"source_type\":\"url\",\"question\":\"Extract non-functional requirements\"}}"}'
```

## 13) MCP Catalog Inspection

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"tool\":\"mcp_servers\",\"args\":{}}"}'
```
