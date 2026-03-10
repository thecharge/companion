# Skills Guide

## Overview

Companion supports two skill implementations:

- `script`: executes runtime code in sandbox/runtime context.
- `guide`: returns instructional workflows and reusable procedural guidance.

Use `guide` for teach/how-to scenarios (SQL playbooks, operational checklists, coding workflows) where execution is not required.

## Skill YAML Schema

```yaml
name: example-skill
version: "1.0.0"
description: "Human readable summary"
tags: [generated, automation]

tools:
  - name: example_tool
    kind: guide # or script
    description: "Tool description"
    parameters:
      topic:
        type: string
        description: "Topic for this guide"
        required: true
    guide: |
      Procedure for: {{topic}}
      1) ...
      2) ...
```

For `script` tools, use `script:` (and optional `timeout:`) instead of `guide:`.

## Placeholder Expansion

Guide skills support handlebars-like placeholders in guide text:

- `{{topic}}`
- `{{task}}`
- `{{dialect}}`

Values come from tool call arguments.

## Runtime Behavior

- Skills are loaded from `./skills` at server startup.
- Loaded skill tools are registered in tool registry.
- Loaded skill tools are attached to configured skill-capable agents (responder/promoted/skill-worker groups, or fallback tool-capable agents).
- New skills created through proposal flow are immediately registered for active sessions.

## Skill Proposal Flow

1. Companion detects a reusable missing capability.
2. It proposes a skill with implementation type (`script` or `guide`).
3. User confirms with `yes` to create or rejects with `no` to cancel.
4. On reject, proposal state is cleared and no file is generated.

## Recommended Patterns

- Prefer `guide` for:
  - SQL teaching
  - architecture/process playbooks
  - operational runbooks
  - coding workflow templates
- Prefer `script` for deterministic executable automation with verifiable output.

## Troubleshooting

If a skill appears loaded but is not used:

1. Check `/capabilities` includes the skill tool.
2. Confirm agent tool list includes the skill tool.
3. For teaching tasks, ensure tool description includes `[skill:guide]` prefix (added automatically for skill tools).
4. Check `/audit/events` for `tool_start`/`tool_end` entries and metadata (`agent`, `tool`, `error`).

## Direct Skill Invocation

Companion accepts direct tool-call JSON payloads in a message. This is the most explicit way to invoke a skill tool.

Single tool call shape:

```json
{"tool":"skill_tool_name","args":{"param":"value"}}
```

Multi-tool call shape:

```json
{"tool_calls":[{"tool":"tool_a","args":{}},{"tool":"tool_b","args":{"query":"..."}}]}
```

## Skill Invocation Examples (All Built-In Skills)

Each entry below can be sent as `content` in `POST /sessions/<SESSION_ID>/messages`.

| Skill | Tool | Example |
| --- | --- | --- |
| `bash` | `bash_exec` | `{"tool":"bash_exec","args":{"command":"pwd && ls -la"}}` |
| `compliance-readiness` | `compliance_gap_report` | `{"tool":"compliance_gap_report","args":{"focus":"soc2"}}` |
| `database` | `sqlite_query` | `{"tool":"sqlite_query","args":{"database":"./data/companion.db","query":"select id,title from sessions order by created_at desc limit 5"}}` |
| `file-edit` | `search_replace` | `{"tool":"search_replace","args":{"path":"README.md","search":"Old text","replace":"New text"}}` |
| `git-branch-hygiene` | `git_branch_hygiene_check` | `{"tool":"git_branch_hygiene_check","args":{"repo_path":".","stale_days":30}}` |
| `ops-control-plane` | `incident_triage` | `{"tool":"incident_triage","args":{"service":"companion-server","symptom":"5xx spike after deploy"}}` |
| `ops-control-plane` | `release_readiness` | `{"tool":"release_readiness","args":{"change_scope":"integration webhook hardening"}}` |
| `prd-design` | `prd_outline` | `{"tool":"prd_outline","args":{"feature":"Session replay controls","users":"operators","constraints":"no downtime"}}` |
| `provider-readiness` | `provider_readiness_report` | `{"tool":"provider_readiness_report","args":{"config_path":"companion.yaml"}}` |
| `skill-factory` | `create_skill_template` | `{"tool":"create_skill_template","args":{"skill_name":"api-contract-review","description":"Checks API contract diffs","tool_name":"api_contract_review"}}` |
| `skill-of-skills` | `skill_of_skills` | `{"tool":"skill_of_skills","args":{"query":"I need a release checklist and rollback plan"}}` |
| `sql-workflow-guide-skill` | `sql_workflow_guide` | `{"tool":"sql_workflow_guide","args":{"task":"top customers by revenue in last 30 days","dialect":"sqlite"}}` |
| `subagent-coordination` | `decomposition_plan` | `{"tool":"decomposition_plan","args":{"objective":"Add MCP catalog support","lanes":"product,engineering,ops"}}` |
| `web-resource-research` | `research_web_resource` | `{"tool":"research_web_resource","args":{"url":"https://modelcontextprotocol.io/","focus":"security and transport model"}}` |
| `file-source-research` | `research_file_source` | `{"tool":"research_file_source","args":{"source":"/tmp/test.log","source_type":"local","question":"latest error root cause"}}` |
