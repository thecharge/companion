/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@companion/config";
import { Blackboard, asSession } from "@companion/core";
import { ToolRegistry } from "@companion/tools";
import { SessionProcessor } from "./index";
import { PENDING_SKILL_KEY, type ProposedSkillSpec } from "./skill-acquisition";

function createTestConfig(): Config {
  return {
    server: { port: 3000, host: "127.0.0.1", secret: "test" },
    db: { driver: "sqlite", sqlite: { path: ":memory:" }, postgres: { url: "" } },
    vector: {
      backend: "sqlite-vec",
      embedding: { model: "test-embed", dimensions: 1 },
    },
    models: {
      local: {
        provider: "ollama",
        model: "qwen2.5:3b",
        max_tokens: 512,
        temperature: 0,
      },
    },
    orchestrator: {
      model: "local",
      max_rounds: 3,
      verify_results: false,
    },
    agents: {
      engineer: {
        model: "local",
        description: "Engineering agent",
        tools: ["run_shell"],
        reads_from: [],
        writes_to: [],
        max_turns: 2,
      },
      analyst: {
        model: "local",
        description: "Analysis agent",
        tools: ["web_fetch"],
        reads_from: [],
        writes_to: [],
        max_turns: 2,
      },
      responder: {
        model: "local",
        description: "Responder agent",
        tools: [],
        reads_from: [],
        writes_to: [],
        max_turns: 2,
      },
    },
    memory: {
      context_window: { max_messages: 10, max_tokens: 2000 },
      sliding_window: { chunk_size: 500, page_size: 10 },
      recall: { top_k: 3, min_score: 0.5, cross_session: false },
      summarisation: { enabled: false, trigger_at_messages: 999, model: "local" },
    },
    mode: {
      default: "local",
      presets: {
        local: { description: "Local mode" },
      },
    },
    tools: {},
    sandbox: {
      runtime: "direct",
      allow_direct_fallback: true,
      image: "companion-sandbox:latest",
      network: "none",
      timeout_seconds: 30,
      tests_timeout_seconds: 60,
    },
  };
}

function createMultiModelConfig(): Config {
  const cfg = createTestConfig();
  cfg.models.smart = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    api_key: "test-key",
    max_tokens: 1024,
    temperature: 0,
  };
  cfg.models.fast = {
    provider: "openai",
    model: "gpt-5-mini",
    api_key: "test-key",
    max_tokens: 1024,
    temperature: 0,
  };
  cfg.mode.default = "balanced";
  cfg.mode.presets.balanced = { description: "Hybrid mode" };
  cfg.mode.presets.cloud = { description: "Cloud mode" };
  cfg.agents.researcher = {
    model: "smart",
    description: "Extra agent to verify extensibility",
    tools: ["web_fetch"],
    reads_from: [],
    writes_to: [],
    max_turns: 3,
  };
  return cfg;
}

describe("agents exports", () => {
  test("SessionProcessor is constructable", () => {
    expect(typeof SessionProcessor).toBe("function");
  });

  test("explicit skill request proposes then creates/registers on yes", async () => {
    const cwdBefore = process.cwd();
    const tmp = await mkdtemp(join(tmpdir(), "companion-agents-test-"));
    process.chdir(tmp);

    try {
      const cfg = createTestConfig();
      const registry = new ToolRegistry();
      const processor = new SessionProcessor(cfg, registry, {} as never, {} as never);
      const blackboard = new Blackboard({ goal: "Add new reusable capability" });

      const propose = await processor.handleMessage({
        session_id: asSession("s-test"),
        blackboard,
        user_message: "create a skill for git branch hygiene checks",
        history: [],
        working_dir: tmp,
        mode: "local",
      });

      expect(propose.reply).toContain("propose a new skill");
      const scratch = blackboard.read("scratchpad") as Record<string, unknown>;
      const pending = scratch[PENDING_SKILL_KEY] as ProposedSkillSpec;
      expect(pending).toBeDefined();
      expect(pending.tool_name).toContain("git_branch_hygiene");

      const confirm = await processor.handleMessage({
        session_id: asSession("s-test"),
        blackboard,
        user_message: "yes",
        history: [],
        working_dir: tmp,
        mode: "local",
      });

      expect(confirm.reply).toContain("now registered and available");
      expect(registry.get(pending.tool_name)).toBeDefined();
      expect(cfg.agents.engineer.tools.includes(pending.tool_name)).toBeTrue();
      expect(cfg.agents.analyst.tools.includes(pending.tool_name)).toBeTrue();
    } finally {
      process.chdir(cwdBefore);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("runtime mode remapping preserves extensibility", () => {
    const cfg = createMultiModelConfig();
    const processor = new SessionProcessor(cfg, new ToolRegistry(), {} as never, {} as never) as unknown as {
      runtimeConfig: (mode: string) => Config;
    };

    const balanced = processor.runtimeConfig("balanced");
    expect(balanced.orchestrator.model).toBe("local");
    expect(balanced.agents.analyst?.model).toBe("smart");
    expect(balanced.agents.engineer?.model).toBe("smart");
    expect(balanced.agents.responder?.model).toBe("fast");
    expect(balanced.agents.researcher?.model).toBe("smart");

    const cloud = processor.runtimeConfig("cloud");
    expect(cloud.orchestrator.model).toBe("smart");
    expect(cloud.agents.analyst?.model).toBe("smart");
    expect(cloud.agents.engineer?.model).toBe("smart");
    expect(cloud.agents.responder?.model).toBe("fast");
    expect(cloud.agents.researcher?.model).toBe("smart");
  });

  test("explicit skill intent short-circuits orchestration in all modes", async () => {
    const cfg = createMultiModelConfig();
    const processor = new SessionProcessor(cfg, new ToolRegistry(), {} as never, {} as never);

    for (const mode of ["local", "balanced", "cloud"]) {
      const bb = new Blackboard({ goal: "Acquire reusable capability" });
      const result = await processor.handleMessage({
        session_id: asSession(`s-${mode}`),
        blackboard: bb,
        user_message: "create a skill for repo branch hygiene checks",
        history: [],
        working_dir: ".",
        mode,
      });

      expect(result.stopped_reason).toBe("done");
      expect(result.reply).toContain("propose a new skill");
      const scratch = bb.read("scratchpad") as Record<string, unknown>;
      expect(scratch[PENDING_SKILL_KEY]).toBeDefined();
    }
  });
});
