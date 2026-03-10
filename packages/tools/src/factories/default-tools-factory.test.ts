import { describe, expect, test } from "bun:test";
import type { Config } from "@companion/config";
import { createMemoryDB } from "@companion/db";
import { createDefaultTools } from "./default-tools-factory";

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
      roles: { responder: "", promoted_agents: [], skill_worker_agents: [] },
      intent_routes: [],
    },
    agents: {},
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

describe("default tools factory", () => {
  test("returns default tool set including core and ops tools", () => {
    const cfg = createConfig();
    const db = createMemoryDB();
    const { tools } = createDefaultTools(cfg, db);
    const names = tools.map((tool) => tool.schema.function.name);

    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("repo_map");
    expect(names).toContain("runtime_posture");
    expect(names).toContain("provider_matrix");
  });
});
