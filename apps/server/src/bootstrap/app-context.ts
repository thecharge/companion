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

function existingAgentNames(cfg: Config, names: string[]): string[] {
  return names.filter((name) => Boolean(cfg.agents[name]));
}

function skillTargetAgents(cfg: Config): string[] {
  const responder = cfg.orchestrator.roles?.responder;
  const promoted = existingAgentNames(cfg, cfg.orchestrator.roles?.promoted_agents ?? []);
  const workers = existingAgentNames(cfg, cfg.orchestrator.roles?.skill_worker_agents ?? []);
  const fallback = Object.entries(cfg.agents)
    .filter(([, agent]) => agent.tools.length > 0)
    .map(([name]) => name);

  const set = new Set<string>([
    ...(responder && cfg.agents[responder] ? [responder] : []),
    ...(promoted.length ? promoted : fallback),
    ...(workers.length ? workers : fallback),
  ]);

  return [...set];
}

function attachLoadedSkillsToAgents(cfg: Config, skills: Skill[]): void {
  const toolNames = skills.flatMap((skill) => skill.tools.map((tool) => tool.name));
  if (!toolNames.length) return;

  const targets = skillTargetAgents(cfg);
  for (const agentName of targets) {
    const agent = cfg.agents[agentName];
    if (!agent) continue;
    for (const toolName of toolNames) {
      if (!agent.tools.includes(toolName)) {
        agent.tools.push(toolName);
      }
    }
  }

  log.info("attached loaded skills to agents", {
    skill_tools: toolNames.length,
    target_agents: targets,
  });
}

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
  attachLoadedSkillsToAgents(cfg, skills);

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

    if (event.type === "agent_start") {
      const payload = event.payload as Record<string, unknown>;
      log.info(`agent_start session=${event.session_id}`, {
        agent: String(payload.agent ?? ""),
      });
      return;
    }

    if (event.type === "agent_end") {
      const payload = event.payload as Record<string, unknown>;
      log.info(`agent_end session=${event.session_id}`, {
        agent: String(payload.agent ?? ""),
        stopped_reason: String(payload.stopped_reason ?? ""),
      });
      return;
    }

    if (event.type === "tool_start") {
      const payload = event.payload as Record<string, unknown>;
      log.info(`tool_start session=${event.session_id}`, {
        tool: String(payload.tool ?? ""),
        agent: String(payload.agent ?? ""),
      });
      return;
    }

    if (event.type === "tool_end") {
      const payload = event.payload as Record<string, unknown>;
      log.info(`tool_end session=${event.session_id}`, {
        tool: String(payload.tool ?? ""),
        duration_ms: Number(payload.duration_ms ?? 0),
        error: payload.error ? String(payload.error) : undefined,
      });
      return;
    }

    if (event.type === "error") {
      const payload = event.payload as Record<string, unknown>;
      log.error(`event_error session=${event.session_id}`, {
        error: String(payload.error ?? ""),
      });
    }
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
