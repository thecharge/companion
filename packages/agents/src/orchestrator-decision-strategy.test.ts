import { describe, expect, test } from "bun:test";
import type { Config } from "@companion/config";
import { Blackboard } from "@companion/core";
import { ToolRegistry } from "@companion/tools";
import { decideOrchestratorAction } from "./orchestrator-decision-strategy";

function createConfig(): Config {
  return {
    server: { port: 3000, host: "127.0.0.1", secret: "test" },
    db: { driver: "sqlite", sqlite: { path: ":memory:" }, postgres: { url: "" } },
    vector: { backend: "sqlite-vec", embedding: { model: "embed", dimensions: 3 } },
    models: {
      local: { provider: "ollama", model: "qwen3:1.7b", max_tokens: 100, temperature: 0 },
    },
    orchestrator: {
      model: "local",
      max_rounds: 1,
      verify_results: false,
      workflow_tracks: {},
      roles: { responder: "responder", promoted_agents: [], skill_worker_agents: [] },
      intent_routes: [],
    },
    agents: {
      responder: {
        model: "local",
        description: "responder",
        tools: [],
        reads_from: [],
        writes_to: [],
        max_turns: 1,
      },
    },
    memory: {
      context_window: { max_messages: 10, max_tokens: 1000 },
      sliding_window: { chunk_size: 200, page_size: 10 },
      recall: { top_k: 2, min_score: 0.5, cross_session: false },
      summarisation: { enabled: false, trigger_at_messages: 999, model: "local" },
    },
    mode: { default: "local", presets: { local: { description: "local" } } },
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

describe("orchestrator decision strategy", () => {
  test("returns forced agent decision without LLM call", async () => {
    const decision = await decideOrchestratorAction({
      runtimeCfg: createConfig(),
      forcedAgent: "engineer",
      blackboard: new Blackboard({ goal: "x" }),
      mode: "local",
      registry: new ToolRegistry(),
      userMessage: "run engineer",
      responder: "responder",
    });

    expect(decision.action).toBe("run_agent");
    expect(decision.target).toBe("engineer");
  });
});
