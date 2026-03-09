/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigStore, loadConfig, resolveWorkingDirConfig } from "./index";

const repoConfigPath = resolve(import.meta.dir, "../../../companion.yaml");

describe("config", () => {
  test("loads workspace config", async () => {
    const cfg = await loadConfig(repoConfigPath);
    expect(cfg.server.port).toBeNumber();
    expect(cfg.models.local?.provider).toBe("ollama");
  });

  test("config store returns patched mode", async () => {
    const cfg = await loadConfig(repoConfigPath);
    const store = new ConfigStore(cfg);
    const sid = "session-1";
    store.patchSession(sid, { mode: { default: "cloud" } });
    expect(store.get(sid).mode.default).toBe("cloud");
  });

  test("loads workflow tracks from orchestrator config", async () => {
    const cfg = await loadConfig(repoConfigPath);
    expect(cfg.orchestrator.workflow_tracks.product_delivery?.stages.length).toBeGreaterThan(0);
    expect(cfg.orchestrator.workflow_tracks.operations?.triggers.length).toBeGreaterThan(0);
  });

  test("merges agents from agents_dir", async () => {
    const temp = await mkdtemp(join(tmpdir(), "companion-config-test-"));
    const agentsDir = join(temp, "agents");
    await mkdir(agentsDir, { recursive: true });

    await writeFile(
      join(agentsDir, "reviewer.yaml"),
      [
        "name: reviewer",
        "model: local",
        'description: "Review code quality"',
        "tools: [read_file]",
        "reads_from: [goal]",
        "writes_to: [observations]",
        "max_turns: 4",
        "",
      ].join("\n"),
    );

    const cfgPath = join(temp, "companion.yaml");
    await writeFile(
      cfgPath,
      [
        "server:",
        "  port: 3000",
        "  host: 127.0.0.1",
        "  secret: dev-secret",
        "db:",
        "  driver: sqlite",
        "  sqlite:",
        "    path: ./tmp.db",
        "vector:",
        "  backend: sqlite-vec",
        "  embedding:",
        "    model: nomic-embed-text",
        "    dimensions: 768",
        "models:",
        "  local:",
        "    provider: ollama",
        "    model: qwen3:1.7b",
        "orchestrator:",
        "  model: local",
        "  max_rounds: 2",
        "  verify_results: false",
        "agents:",
        "  engineer:",
        "    model: local",
        '    description: "Engineer"',
        "    tools: []",
        "    reads_from: []",
        "    writes_to: []",
        "    max_turns: 2",
        "agents_dir: ./agents",
        "memory:",
        "  context_window:",
        "    max_messages: 10",
        "    max_tokens: 1000",
        "  sliding_window:",
        "    chunk_size: 200",
        "    page_size: 10",
        "  recall:",
        "    top_k: 3",
        "    min_score: 0.5",
        "    cross_session: false",
        "  summarisation:",
        "    enabled: false",
        "    trigger_at_messages: 999",
        "    model: local",
        "mode:",
        "  default: local",
        "  presets:",
        "    local:",
        '      description: "local"',
        "tools: {}",
        "sandbox:",
        "  runtime: direct",
        "  allow_direct_fallback: true",
        "  image: companion-sandbox:latest",
        "  network: none",
        "  timeout_seconds: 30",
        "  tests_timeout_seconds: 60",
        "",
      ].join("\n"),
    );

    try {
      const cfg = await loadConfig(cfgPath);
      expect(cfg.agents.reviewer?.description).toBe("Review code quality");
      expect(cfg.agents.engineer).toBeDefined();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test("applies nearest working-dir override", async () => {
    const temp = await mkdtemp(join(tmpdir(), "companion-config-override-"));
    const repoDir = join(temp, "repo");
    const appDir = join(repoDir, "apps", "api");
    await mkdir(appDir, { recursive: true });

    const rootCfgPath = join(repoDir, "companion.yaml");
    await writeFile(
      rootCfgPath,
      [
        "server:",
        "  port: 3000",
        "  host: 127.0.0.1",
        "  secret: dev-secret",
        "db:",
        "  driver: sqlite",
        "  sqlite:",
        "    path: ./tmp.db",
        "vector:",
        "  backend: sqlite-vec",
        "  embedding:",
        "    model: nomic-embed-text",
        "    dimensions: 768",
        "models:",
        "  local:",
        "    provider: ollama",
        "    model: qwen3:1.7b",
        "orchestrator:",
        "  model: local",
        "  max_rounds: 2",
        "  verify_results: false",
        "agents:",
        "  engineer:",
        "    model: local",
        '    description: "Engineer"',
        "    tools: []",
        "    reads_from: []",
        "    writes_to: []",
        "    max_turns: 2",
        "memory:",
        "  context_window:",
        "    max_messages: 10",
        "    max_tokens: 1000",
        "  sliding_window:",
        "    chunk_size: 200",
        "    page_size: 10",
        "  recall:",
        "    top_k: 3",
        "    min_score: 0.5",
        "    cross_session: false",
        "  summarisation:",
        "    enabled: false",
        "    trigger_at_messages: 999",
        "    model: local",
        "mode:",
        "  default: local",
        "  presets:",
        "    local:",
        '      description: "local"',
        "tools: {}",
        "sandbox:",
        "  runtime: direct",
        "  allow_direct_fallback: true",
        "  image: companion-sandbox:latest",
        "  network: none",
        "  timeout_seconds: 30",
        "  tests_timeout_seconds: 60",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(repoDir, "apps", "companion.override.yaml"),
      ["mode:", "  default: cloud", "tools:", "  web_fetch:", "    timeout_seconds: 11", ""].join("\n"),
    );

    try {
      const base = await loadConfig(rootCfgPath);
      const resolved = await resolveWorkingDirConfig(base, appDir, rootCfgPath);
      expect(resolved.mode.default).toBe("cloud");
      expect(resolved.tools.web_fetch?.timeout_seconds).toBe(11);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
