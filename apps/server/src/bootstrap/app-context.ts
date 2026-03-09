/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { SessionProcessor } from "@companion/agents";
import { ConfigStore, loadConfig, type Config } from "@companion/config";
import { type SessionId } from "@companion/core";
import { createDB, type DB } from "@companion/db";
import { createLLMClient } from "@companion/llm";
import { MemoryService, SqliteVecStore } from "@companion/memory";
import { loadSkillsDir, registerSkills, type Skill } from "@companion/skills";
import { createToolRegistry, type ToolRegistry, type SandboxExecutor } from "@companion/tools";
import { runStartupChecks } from "../startup-checks";

export interface AppContext {
  cfg: Config;
  configStore: ConfigStore;
  db: DB;
  memoryService: MemoryService;
  toolRegistry: ToolRegistry;
  sandbox: SandboxExecutor;
  skills: Skill[];
  sessionProcessorFactory: (sessionId: SessionId) => SessionProcessor;
  embedClient: ReturnType<typeof createLLMClient>;
  embedBaseUrl: string;
  embedModelName: string;
  embedAvailable: boolean;
  activeCancels: Map<SessionId, AbortController>;
}

const getEmbedBaseUrl = (cfg: Config): string => {
  const anyOllamaModel = Object.values(cfg.models).find((model) => model.provider === "ollama");
  return (anyOllamaModel?.base_url ?? "http://localhost:11434").replace(/\/$/, "");
};

const checkEmbedAvailability = async (embedBaseUrl: string, embedModelName: string): Promise<boolean> => {
  try {
    const tagsResponse = await fetch(`${embedBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!tagsResponse.ok) {
      return false;
    }

    const tagsPayload = (await tagsResponse.json()) as { models?: Array<{ name: string }> };
    const modelNames = tagsPayload.models?.map((model) => model.name) ?? [];
    const targetPrefix = embedModelName.split(":")[0] ?? embedModelName;
    return modelNames.some((name) => name.startsWith(targetPrefix));
  } catch {
    return false;
  }
};

export const createAppContext = async (): Promise<AppContext> => {
  const cfg = await loadConfig("./companion.yaml");
  const configStore = new ConfigStore(cfg);
  const db = await createDB(cfg);

  const vectorStore = new SqliteVecStore(cfg.db.sqlite.path.replace(".db", "-vec.db"));
  const memoryService = new MemoryService(vectorStore, cfg);

  const { registry: toolRegistry, sandbox } = createToolRegistry(cfg, db);
  const skills = await loadSkillsDir("./skills");
  registerSkills(skills, toolRegistry);

  const embedModelName = cfg.vector.embedding.model;
  const embedBaseUrl = getEmbedBaseUrl(cfg);
  const embedClient = createLLMClient({
    provider: "ollama",
    model: embedModelName,
    base_url: embedBaseUrl,
    max_tokens: 1,
    temperature: 0,
  });

  const embedAvailable = await checkEmbedAvailability(embedBaseUrl, embedModelName);

  await runStartupChecks({
    cfg,
    sandbox,
    embedBase: embedBaseUrl,
    embedModelName,
  });

  const sessionProcessorFactory = (sessionId: SessionId): SessionProcessor => {
    const effectiveConfig = configStore.get(sessionId);
    return new SessionProcessor(effectiveConfig, toolRegistry, memoryService, db);
  };

  return {
    cfg,
    configStore,
    db,
    memoryService,
    toolRegistry,
    sandbox,
    skills,
    sessionProcessorFactory,
    embedClient,
    embedBaseUrl,
    embedModelName,
    embedAvailable,
    activeCancels: new Map<SessionId, AbortController>(),
  };
};
