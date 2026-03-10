import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ProposedSkillParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface ProposedSkillSpec {
  name: string;
  description: string;
  tool_name: string;
  why: string;
  parameters: ProposedSkillParam[];
  implementation_type?: "script" | "guide";
  guide_text?: string;
  script_hint?: string;
}

export const PENDING_SKILL_KEY = "pending_skill_proposal";

const RESERVED_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "list_dir",
  "search_history",
  "search_memory",
  "run_shell",
  "run_tests",
  "web_fetch",
  "weather_lookup",
  "skill_of_skills",
  "create_skill_template",
]);

export function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /\b(yes|y|confirm|approved|do it|create it|go ahead|ship it|ok|okay|please create|proceed)\b/.test(t);
}

export function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /\b(no|n|cancel|decline|reject|not now|skip|don'?t create|do not create|no thanks|stop)\b/.test(t);
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function toToolName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "generated_tool";
}

function cleanDescription(text: string): string {
  return text
    .replace(/\[Relevant memories\][\s\S]*$/i, "")
    .replace(/The current time is [^.]+\.?/gi, "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240);
}

function cleanGuideText(text: string): string {
  return text
    .replace(/\[Relevant memories\][\s\S]*$/i, "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, 2000);
}

function isGitBranchHygieneSpec(spec: ProposedSkillSpec): boolean {
  const blob = `${spec.name} ${spec.tool_name} ${spec.description}`.toLowerCase();
  return blob.includes("git") && blob.includes("branch") && blob.includes("hygiene");
}

export function defaultSkillProposalFromMessage(message: string): Partial<ProposedSkillSpec> {
  const cleanedMessage = cleanDescription(message);
  const normalized = cleanedMessage.toLowerCase().replace(/[^a-z0-9\s]+/g, " ");

  const sqlTeachingIntent =
    /\b(sql|postgres|postgresql|sqlite|database|query|schema|join|index)\b/.test(normalized) &&
    /\b(teach|learn|how|workflow|guide|explain)\b/.test(normalized);

  const genericTeachingIntent =
    /\b(teach|learn|how|workflow|guide|explain|playbook|runbook)\b/.test(normalized) &&
    /\b(tool|process|procedure|steps|method)\b/.test(normalized);

  if (sqlTeachingIntent) {
    return {
      name: "sql_workflow_guide_skill",
      description: "Reusable SQL guidance for schema discovery, query design, validation, and safe execution.",
      tool_name: "sql_workflow_guide",
      why: "User asked for teachable SQL capability, which should be reusable as guidance instead of shell execution.",
      implementation_type: "guide",
      parameters: [
        {
          name: "task",
          type: "string",
          description: "Desired SQL task or question",
          required: true,
        },
      ],
      guide_text: [
        "SQL workflow for: {{task}}",
        "1) Discover schema first (tables, columns, PK/FK, indexes).",
        "2) Draft the query with explicit joins and qualified column names.",
        "3) Validate logic with LIMIT and representative filters before broad scans.",
        "4) Explain expected cardinality and performance risk points.",
        "5) If mutation is needed, wrap in transaction and provide rollback strategy.",
      ].join("\\n"),
    };
  }

  if (genericTeachingIntent) {
    return {
      name: "procedural_guide_skill",
      description: "Reusable procedural guidance for recurring how-to requests.",
      tool_name: "procedural_guide",
      why: "User asked for reusable instructional workflow rather than direct script execution.",
      implementation_type: "guide",
      parameters: [
        {
          name: "topic",
          type: "string",
          description: "Topic to teach, explain, or provide a workflow for",
          required: true,
        },
      ],
      guide_text: [
        "Procedure for: {{topic}}",
        "1) Define prerequisites and constraints.",
        "2) Provide step-by-step execution order.",
        "3) Add validation checks and expected outputs.",
        "4) Include common failure modes and recovery steps.",
      ].join("\\n"),
    };
  }

  const compositeOps =
    /\b(weather|temperature|forecast)\b/.test(normalized) &&
    /\b(system\s+load|cpu\s+load|load\s+average|uptime)\b/.test(normalized) &&
    /\b(time|date|utc)\b/.test(normalized);

  if (compositeOps) {
    return {
      name: "system_load_weather_time_skill",
      description: "Reusable automation for current UTC time, host system load, and weather summary.",
      tool_name: "system_load_weather_time",
      why: "Request combines multiple recurring ops checks into one repeatable workflow.",
      implementation_type: "script",
      parameters: [
        {
          name: "city",
          type: "string",
          description: "City name for weather lookup",
          required: true,
        },
      ],
      script_hint: "Print UTC time and uptime, then fetch weather via Open-Meteo geocoding + forecast.",
    };
  }

  const afterFor = normalized.match(/\bfor\s+(.+)$/)?.[1] ?? normalized;
  const tokens = afterFor
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (t) =>
        !new Set(["please", "create", "add", "build", "generate", "a", "an", "the", "skill", "checks", "check"]).has(t),
    )
    .slice(0, 6);

  const stem = tokens.join("_") || "generated_capability";

  return {
    name: `${stem}_skill`,
    description: `Reusable automation for: ${cleanedMessage.slice(0, 140)}`,
    tool_name: `${stem}_task`,
    why: "Explicit user request to create a reusable skill.",
    implementation_type: "script",
    parameters: [
      {
        name: "input",
        type: "string",
        description: "Primary input",
        required: true,
      },
    ],
  };
}

export function normalizeSkillSpec(input: Partial<ProposedSkillSpec>): ProposedSkillSpec {
  const name = cleanDescription(input.name ?? "new-skill") || "new-skill";
  const description = cleanDescription(input.description ?? "Generated skill") || "Generated skill";
  let toolName = toToolName(input.tool_name ?? `${name} tool`);
  if (RESERVED_TOOL_NAMES.has(toolName)) {
    toolName = `${toolName}_skill`;
  }

  const params: ProposedSkillParam[] = Array.isArray(input.parameters)
    ? input.parameters
        .map((p): ProposedSkillParam => {
          const typed: ProposedSkillParam["type"] = p?.type === "number" || p?.type === "boolean" ? p.type : "string";
          return {
            name: toToolName(String(p?.name ?? "arg")),
            type: typed,
            description: cleanDescription(String(p?.description ?? "parameter")) || "parameter",
            required: p?.required !== false,
          };
        })
        .filter((p) => p.name.length > 0)
    : [];

  return {
    name,
    description,
    tool_name: toolName,
    why: cleanDescription(input.why ?? "Repeated task detected") || "Repeated task detected",
    parameters: params,
    implementation_type: input.implementation_type === "guide" ? "guide" : "script",
    guide_text: cleanGuideText(input.guide_text ?? ""),
    script_hint: cleanDescription(input.script_hint ?? ""),
  };
}

export function buildSkillAcquisitionPrompt(userMessage: string, availableTools: string[]): string {
  const tools = availableTools.join(", ");
  return `You are evaluating whether a new skill should be added to the system.

User request:
${userMessage}

Currently available tools:
${tools}

Rules:
- Recommend a new skill ONLY if this capability is missing or likely to repeat enough to justify reusable automation.
- If existing tools can solve it reliably, set should_acquire to false.
- Keep output strict JSON, no markdown.

Return exactly:
{"should_acquire":true|false,"name":"...","description":"...","tool_name":"...","why":"...","implementation_type":"script|guide","parameters":[{"name":"...","type":"string|number|boolean","description":"...","required":true}],"guide_text":"only when implementation_type=guide","script_hint":"only when implementation_type=script"}`;
}

export function renderSkillYaml(spec: ProposedSkillSpec): string {
  const slug = toSlug(spec.name) || "generated-skill";
  const paramsBlock = spec.parameters.length
    ? spec.parameters
        .map(
          (p) =>
            `      ${p.name}:\n        type: ${p.type}\n        description: "${p.description}"\n        required: ${p.required ? "true" : "false"}`,
        )
        .join("\n")
    : `      input:\n        type: string\n        description: "Input payload"\n        required: true`;

  const firstArg = spec.parameters[0]?.name ?? "input";
  const implementationType = spec.implementation_type === "guide" ? "guide" : "script";

  const scriptHintLine = spec.script_hint ? `# Hint: ${spec.script_hint}\n` : "";
  const scriptBody = isGitBranchHygieneSpec(spec)
    ? [
        "python3 - << 'PYEOF'",
        "import os, sys, time, subprocess",
        "from pathlib import Path",
        "",
        "working_dir = Path(os.environ.get('WORKING_DIR', '.')).resolve()",
        "repo_rel = os.environ.get('COMPANION_ARG_REPO_PATH', '.').strip() or '.'",
        "stale_raw = os.environ.get('COMPANION_ARG_STALE_DAYS', '30').strip() or '30'",
        "try:",
        "    stale_days = int(float(stale_raw))",
        "except Exception:",
        "    stale_days = 30",
        "repo = (working_dir / repo_rel).resolve()",
        "if not str(repo).startswith(str(working_dir)):",
        "    print('ERROR: repo_path escapes working dir')",
        "    sys.exit(1)",
        "",
        "def git(*args):",
        "    p = subprocess.run(['git', *args], cwd=repo, text=True, capture_output=True)",
        "    return p.returncode, p.stdout.strip(), p.stderr.strip()",
        "",
        "if git('rev-parse', '--git-dir')[0] != 0:",
        "    print(f'ERROR: not a git repo: {repo}')",
        "    sys.exit(1)",
        "",
        "_, branch, _ = git('rev-parse', '--abbrev-ref', 'HEAD')",
        "_, status, _ = git('status', '--porcelain')",
        "print(f'Repository: {repo}')",
        "print(f'Current branch: {branch}')",
        'print(f\'Working tree clean: {"yes" if not status else "no"}\')',
        "",
        "up_code, upstream, _ = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')",
        "if up_code == 0 and upstream:",
        "    c, counts, _ = git('rev-list', '--left-right', '--count', f'{upstream}...HEAD')",
        "    if c == 0 and counts:",
        "        behind, ahead = counts.split()",
        "        print(f'Upstream: {upstream} | Ahead: {ahead} | Behind: {behind}')",
        "else:",
        "    print('Upstream: not configured')",
        "",
        "_, refs, _ = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\\t%(committerdate:unix)', 'refs/heads')",
        "cutoff = time.time() - stale_days * 86400",
        "stale = []",
        "for line in refs.splitlines():",
        "    name, ts = line.split('\\t', 1)",
        "    if int(ts) < cutoff and name not in {'main','master','develop',branch}:",
        "        stale.append(name)",
        "print(f'Stale branches (> {stale_days} days): {len(stale)}')",
        "for b in stale[:20]:",
        "    print(f'  {b}')",
        "print('Branch hygiene report complete.')",
        "PYEOF",
      ].join("\n")
    : `${scriptHintLine}echo "TODO: implement ${spec.tool_name}"\n echo "Received ${firstArg}: ${"$"}{COMPANION_ARG_${firstArg.toUpperCase()}}"`;
  const indentedScriptBody = scriptBody
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

  const guideBody =
    spec.guide_text?.trim() ||
    [
      `Guide for ${spec.tool_name}:`,
      `- Understand requested objective: {{${firstArg}}}`,
      "- Produce a clear, step-by-step workflow.",
      "- Include validation, safety checks, and expected outputs.",
    ].join("\n");
  const indentedGuideBody = guideBody
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

  const toolBody =
    implementationType === "guide"
      ? `    kind: guide\n    guide: |\n${indentedGuideBody}`
      : `    timeout: 30\n    script: |\n      set -eu\n${indentedScriptBody}`;

  return `name: ${slug}
version: "1.0.0"
description: "${spec.description}"
tags: [generated, automation]

tools:
  - name: ${spec.tool_name}
    description: "${spec.description}"
    parameters:
${paramsBlock}
${toolBody}
`;
}

export async function createSkillFromProposal(
  specInput: Partial<ProposedSkillSpec>,
): Promise<{ path: string; spec: ProposedSkillSpec }> {
  const spec = normalizeSkillSpec(specInput);
  const slug = toSlug(spec.name) || "generated-skill";
  const root = resolve(process.cwd(), "skills");
  const dir = join(root, slug);
  const filePath = join(dir, "skill.yaml");
  const file = Bun.file(filePath);

  if (await file.exists()) {
    throw new Error(`Skill already exists: ${filePath}`);
  }

  await mkdir(dir, { recursive: true });
  await Bun.write(filePath, renderSkillYaml(spec));
  return { path: filePath, spec };
}
