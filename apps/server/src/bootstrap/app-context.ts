/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { SessionProcessor } from "@companion/agents";
import { type Config, ConfigStore, loadConfig } from "@companion/config";
import { Logger, type SessionId, bus } from "@companion/core";
import { AuditLogRepository, type DB, createDB, createVectorStore } from "@companion/db";
import { createLLMClient } from "@companion/llm";
import { MemoryService } from "@companion/memory";
import { type Skill, loadSkillsDir, registerSkills } from "@companion/skills";
import { type SandboxExecutor, type ToolRegistry, createToolRegistry } from "@companion/tools";
import { AuditLogService } from "../services/audit-log-service";
import { runStartupChecks } from "../startup-checks";

export interface AppContext {
  cfg: Config;
  rootConfigPath: string;
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
  auditLogService: AuditLogService;
}

const DEFAULT_AUDIT_LOG_PATH = "./data/audit-events.ndjson";
const log = new Logger("server.audit");

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
  const rootConfigPath = "./companion.yaml";
  const cfg = await loadConfig(rootConfigPath);
  const configStore = new ConfigStore(cfg);
  const db = await createDB(cfg);

  const vectorStore = createVectorStore(cfg);
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
  const auditLogPath = process.env.COMPANION_AUDIT_LOG_PATH ?? DEFAULT_AUDIT_LOG_PATH;
  const auditLogRepository = new AuditLogRepository({ cfg, mirrorPath: auditLogPath });
  const auditLogService = new AuditLogService(auditLogRepository);
  await auditLogService.initialize();
  bus.on("*", (event) => {
    void auditLogService.recordBusEvent(event).catch((error) => {
      log.warn("audit bus event write failed", error);
    });
  });

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
    rootConfigPath,
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
    auditLogService,
  };
};
