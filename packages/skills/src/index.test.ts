/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
