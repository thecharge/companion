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
