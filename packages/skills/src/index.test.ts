/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSession } from "@companion/core";
import { ToolRegistry } from "@companion/tools";
import { loadSkillsDir, registerSkills } from "./index";

describe("skills loader", () => {
  test("returns empty for missing directory", async () => {
    const skills = await loadSkillsDir("./does-not-exist");
    expect(skills).toEqual([]);
  });

  test("loads and registers skill tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-skills-"));
    const skillDir = join(dir, "demo");
    await Bun.write(
      join(skillDir, "skill.yaml"),
      [
        "name: demo",
        'version: "1.0.0"',
        'description: "demo"',
        "tools:",
        "  - name: demo_tool",
        '    description: "demo tool"',
        "    parameters:",
        "      input:",
        "        type: string",
        '        description: "input"',
        "        required: true",
        "    timeout: 1",
        "    script: |",
        '      echo "ok"',
      ].join("\n"),
      { createPath: true },
    );

    const skills = await loadSkillsDir(dir);
    const registry = new ToolRegistry();
    registerSkills(skills, registry);
    expect(skills.length).toBe(1);
    expect(registry.get("demo_tool")?.schema.function.name).toBe("demo_tool");

    await rm(dir, { recursive: true, force: true });
  });

  test("loads guide skill tools without script", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-skills-guide-"));
    const skillDir = join(dir, "sql");
    await Bun.write(
      join(skillDir, "skill.yaml"),
      [
        "name: sql-guide",
        'version: "1.0.0"',
        'description: "sql guide"',
        "tools:",
        "  - name: sql_teach",
        '    kind: "guide"',
        '    description: "Explain SQL workflow and query crafting"',
        "    parameters:",
        "      task:",
        "        type: string",
        '        description: "desired task"',
        "        required: true",
        "    guide: |",
        "      1) Inspect schema for {{task}}",
        "      2) Build SELECT with filters",
        "      3) Validate with LIMIT first",
      ].join("\n"),
      { createPath: true },
    );

    const skills = await loadSkillsDir(dir);
    const registry = new ToolRegistry();
    registerSkills(skills, registry);
    const result = await registry.run(
      { id: "1", tool_name: "sql_teach", args: { task: "top customers" } },
      { session_id: asSession("s1"), working_dir: process.cwd(), db: null as never, cfg: null as never },
    );

    expect(result.error).toBeUndefined();
    expect(String(result.result ?? "")).toContain("Inspect schema for top customers");

    await rm(dir, { recursive: true, force: true });
  });
});
