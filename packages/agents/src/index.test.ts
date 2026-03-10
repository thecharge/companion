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
import { SessionProcessor, detectWorkflowTrack } from "./index";
import { buildRuntimeConfig } from "./runtime-config";
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
      workflow_tracks: {
        product_delivery: {
          triggers: ["prd", "product requirement", "roadmap", "feature spec", "acceptance criteria", "delivery plan"],
          stages: ["planner", "prd_designer", "delivery_manager", "engineer", "responder"],
        },
        operations: {
          triggers: [
            "incident",
            "outage",
            "operations",
            "runbook",
            "sre",
            "deployment",
            "rollback",
            "release",
            "postmortem",
          ],
          stages: ["planner", "operations_commander", "analyst", "engineer", "responder"],
        },
      },
      roles: {
        responder: "responder",
        promoted_agents: ["analyst", "engineer"],
        skill_worker_agents: ["analyst", "engineer"],
      },
      intent_routes: [],
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
    integrations: {
      slack: {
        enabled: false,
        trusted_user_ids: [],
        trusted_channel_ids: [],
        trusted_team_ids: [],
        default_session_title: "Slack Session",
        max_message_chars: 2000,
        max_events_per_minute: 30,
      },
      telegram: {
        enabled: false,
        trusted_user_ids: [],
        trusted_chat_ids: [],
        default_session_title: "Telegram Session",
        max_message_chars: 2000,
        max_events_per_minute: 30,
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

  test("pending proposal cancels cleanly on no", async () => {
    const cwdBefore = process.cwd();
    const tmp = await mkdtemp(join(tmpdir(), "companion-agents-test-no-"));
    process.chdir(tmp);

    try {
      const cfg = createTestConfig();
      const registry = new ToolRegistry();
      const processor = new SessionProcessor(cfg, registry, {} as never, {} as never);
      const blackboard = new Blackboard({ goal: "Add capability" });

      const propose = await processor.handleMessage({
        session_id: asSession("s-no"),
        blackboard,
        user_message: "create a skill for git branch hygiene checks",
        history: [],
        working_dir: tmp,
        mode: "local",
      });

      expect(propose.reply).toContain("propose a new skill");

      const reject = await processor.handleMessage({
        session_id: asSession("s-no"),
        blackboard,
        user_message: "no thanks, do not create it",
        history: [],
        working_dir: tmp,
        mode: "local",
      });

      expect(reject.reply.toLowerCase()).toContain("cancelled skill proposal");
      const scratch = blackboard.read("scratchpad") as Record<string, unknown>;
      expect(scratch[PENDING_SKILL_KEY]).toBeNull();
    } finally {
      process.chdir(cwdBefore);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("teaching SQL request proposes guide skill", async () => {
    const cfg = createTestConfig();
    const processor = new SessionProcessor(cfg, new ToolRegistry(), {} as never, {} as never);
    const blackboard = new Blackboard({ goal: "Teach SQL workflow" });

    const result = await processor.handleMessage({
      session_id: asSession("s-guide"),
      blackboard,
      user_message: "teach the agent how to create SQL queries and workflow",
      history: [],
      working_dir: ".",
      mode: "local",
    });

    expect(result.reply).toContain("propose a new skill");
    expect(result.reply).toContain("(guide)");
  });

  test("runtime mode remapping preserves extensibility", () => {
    const cfg = createMultiModelConfig();
    const balanced = buildRuntimeConfig(cfg, "balanced");
    expect(balanced.orchestrator.model).toBe("local");
    expect(balanced.agents.analyst?.model).toBe("smart");
    expect(balanced.agents.engineer?.model).toBe("smart");
    expect(balanced.agents.responder?.model).toBe("fast");
    expect(balanced.agents.researcher?.model).toBe("smart");

    const cloud = buildRuntimeConfig(cfg, "cloud");
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

  test("detects workflow tracks for product and operations intents", () => {
    const cfg = createMultiModelConfig();
    expect(detectWorkflowTrack("Create a PRD and delivery plan for feature rollout", cfg)).toBe("product_delivery");
    expect(detectWorkflowTrack("Investigate outage and create incident runbook", cfg)).toBe("operations");
    expect(detectWorkflowTrack("answer this quick question", cfg)).toBe("standard");
  });
});
