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

export function normalizeSkillSpec(input: Partial<ProposedSkillSpec>): ProposedSkillSpec {
  const name = cleanDescription(input.name ?? "new-skill") || "new-skill";
  const description = cleanDescription(input.description ?? "Generated skill") || "Generated skill";
  const toolName = toToolName(input.tool_name ?? `${name} tool`);

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
      ${scriptHintLine}echo "TODO: implement ${spec.tool_name}"
      echo "Received ${firstArg}: ${"$"}{COMPANION_ARG_${firstArg.toUpperCase()}}"
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
