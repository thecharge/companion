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
  return /^(yes|y|confirm|approved|do it|create it|go ahead|ship it|ok|okay)\b/.test(t);
}

export function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(no|n|cancel|decline|reject|not now|skip)\b/.test(t);
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
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240);
}

function isGitBranchHygieneSpec(spec: ProposedSkillSpec): boolean {
  const blob = `${spec.name} ${spec.tool_name} ${spec.description}`.toLowerCase();
  return blob.includes("git") && blob.includes("branch") && blob.includes("hygiene");
}

export function defaultSkillProposalFromMessage(message: string): Partial<ProposedSkillSpec> {
  const normalized = message.toLowerCase().replace(/[^a-z0-9\s]+/g, " ");
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
    description: `Generated skill for: ${message.slice(0, 140)}`,
    tool_name: `${stem}_task`,
    why: "Explicit user request to create a reusable skill.",
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
{"should_acquire":true|false,"name":"...","description":"...","tool_name":"...","why":"...","parameters":[{"name":"...","type":"string|number|boolean","description":"...","required":true}],"script_hint":"short implementation hint"}`;
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

  return `name: ${slug}
version: "1.0.0"
description: "${spec.description}"
tags: [generated, automation]

tools:
  - name: ${spec.tool_name}
    description: "${spec.description}"
    parameters:
${paramsBlock}
    timeout: 30
    script: |
      set -eu
${indentedScriptBody}
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
