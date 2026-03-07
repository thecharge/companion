/**
 * @companion/skills
 *
 * Loads .skill.yaml files and registers their tools into the ToolRegistry.
 *
 * Security: arguments are passed as COMPANION_ARG_* environment variables.
 * LLM output NEVER touches the script string — no injection surface.
 * The subprocess environment is built from scratch — server secrets do not leak.
 */

import { parse as parseYaml } from "yaml";
import { join, dirname } from "node:path";
import type { ToolRegistry, ToolContext } from "@companion/tools";

// ── Skill schema (runtime validated, not Zod — keeps dep tree clean) ──

interface SkillParam {
  type:        "string" | "number" | "boolean";
  description: string;
  required?:   boolean;
}

interface SkillTool {
  name:         string;
  description:  string;
  parameters:   Record<string, SkillParam>;
  script?:      string;
  script_file?: string;
  timeout?:     number;
}

export interface Skill {
  name:        string;
  version:     string;
  description: string;
  tags?:       string[];
  prompt?:     string;
  tools:       SkillTool[];
}

// ── Loader ────────────────────────────────────────────────────

export async function loadSkillsDir(dir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const dirFile = Bun.file(dir);

  // Directory may not exist yet — that's fine
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const yamlPath = join(dir, entry.name, "skill.yaml");
        const skill    = await loadSkillFile(yamlPath);
        if (skill) skills.push(skill);
      } else if (entry.name.endsWith(".skill.yaml")) {
        const skill = await loadSkillFile(join(dir, entry.name));
        if (skill) skills.push(skill);
      }
    }
  } catch {
    // Directory doesn't exist — return empty
  }

  void dirFile; // suppress unused warning
  return skills;
}

async function loadSkillFile(path: string): Promise<Skill | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const raw  = await file.text();
    const data = parseYaml(raw) as Skill;
    if (!data.name || !Array.isArray(data.tools)) return null;
    return data;
  } catch (e) {
    console.warn(`[skills] Failed to load ${path}: ${e}`);
    return null;
  }
}

// ── Registration ──────────────────────────────────────────────

export function registerSkills(skills: Skill[], registry: ToolRegistry): void {
  for (const skill of skills) {
    for (const tool of skill.tools) {
      registry.register({
        schema: {
          type: "function",
          function: {
            name:        tool.name,
            description: tool.description,
            parameters: {
              type:       "object",
              properties: Object.fromEntries(
                Object.entries(tool.parameters).map(([k, v]) => [
                  k,
                  { type: v.type, description: v.description },
                ]),
              ),
              required: Object.entries(tool.parameters)
                .filter(([, v]) => v.required !== false)
                .map(([k]) => k),
            },
          },
        },
        handler: makeHandler(skill, tool, dirname(/* skill dir */ "")),
      });
    }
  }
}

function makeHandler(
  skill:   Skill,
  tool:    SkillTool,
  _dir:    string,
) {
  return async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const timeoutMs = (tool.timeout ?? 30) * 1000;

    // Build safe environment — server secrets NEVER forwarded
    const safeEnv: Record<string, string> = {
      PATH:        process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME:        process.env["HOME"] ?? "/tmp",
      TMPDIR:      process.env["TMPDIR"] ?? "/tmp",
      WORKING_DIR: ctx.working_dir,
      SESSION_ID:  String(ctx.session_id),
    };

    // Arguments as COMPANION_ARG_* — OS process boundary, not string interpolation
    for (const [key, value] of Object.entries(args)) {
      safeEnv[`COMPANION_ARG_${key.toUpperCase()}`] = String(value ?? "");
    }

    const script = tool.script ?? "";
    if (!script.trim()) return "Error: skill tool has no script";

    const interpreter = script.trimStart().startsWith("import ") ||
      script.trimStart().startsWith("const ") ||
      script.trimStart().startsWith("import {")
      ? ["bun", "run", "-e", script]
      : ["bash", "-c", script];

    const proc = Bun.spawn(interpreter, {
      cwd:    ctx.working_dir,
      env:    safeEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill(), timeoutMs);

    try {
      await proc.exited;
    } finally {
      clearTimeout(timeout);
    }

    const stdout   = await new Response(proc.stdout).text();
    const stderr   = await new Response(proc.stderr).text();
    const exitCode = proc.exitCode ?? 1;

    if (exitCode !== 0) {
      return `Error (exit ${exitCode}):\n${stderr || stdout}`;
    }
    return stdout || "(no output)";
  };
}
