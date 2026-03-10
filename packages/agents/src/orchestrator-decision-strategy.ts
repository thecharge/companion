import type { Config } from "@companion/config";
import type { Blackboard } from "@companion/core";
import { Logger } from "@companion/core";
import { createLLMClient } from "@companion/llm";
import type { ToolRegistry } from "@companion/tools";
import { buildOrchestratorPrompt } from "./prompts";

const log = new Logger("agents.orchestrator-decision");

export interface OrchestratorDecision {
  action: string;
  target?: string;
  reason?: string;
}

interface DecideOrchestratorActionParams {
  runtimeCfg: Config;
  forcedAgent?: string | null;
  blackboard: Blackboard;
  mode: string;
  registry: ToolRegistry;
  userMessage: string;
  responder: string;
  signal?: AbortSignal;
}

export const decideOrchestratorAction = async (
  params: DecideOrchestratorActionParams,
): Promise<OrchestratorDecision> => {
  const { runtimeCfg, forcedAgent, blackboard, mode, registry, userMessage, responder, signal } = params;

  if (forcedAgent) {
    return {
      action: "run_agent",
      target: forcedAgent,
      reason: "intent route: required tool capability detected",
    };
  }

  const orchAlias = runtimeCfg.orchestrator.model;
  const orchCfg = runtimeCfg.models[orchAlias];
  if (!orchCfg) {
    throw new Error(`Orchestrator model alias not found: ${orchAlias}`);
  }

  const orchLLM = createLLMClient(orchCfg);
  const response = await orchLLM.chat({
    messages: [
      { role: "system", content: buildOrchestratorPrompt(runtimeCfg, registry, blackboard, mode) },
      { role: "user", content: userMessage },
    ],
    json_mode: orchCfg.provider === "ollama",
    signal,
  });

  const raw = response.choices[0]?.message.content ?? "";
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as OrchestratorDecision;
  } catch {
    log.warn("Orchestrator non-JSON - defaulting to first configured agent", { raw: raw.slice(0, 80) });
    const fallback = Object.keys(runtimeCfg.agents)[0] ?? responder;
    return { action: "run_agent", target: fallback, reason: "parse fallback" };
  }
};
