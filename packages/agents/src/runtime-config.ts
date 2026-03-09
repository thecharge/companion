import type { Config } from "@companion/config";
import { BaseAgent } from "./agent-ids";

const promotedAgents = (cfg: Config): string[] => {
  return Object.keys(cfg.agents).filter((name) => name !== BaseAgent.Responder);
};

export const buildRuntimeConfig = (base: Config, mode: string): Config => {
  if (mode === "local") return base;

  const clone: Config = {
    ...base,
    orchestrator: { ...base.orchestrator },
    agents: Object.fromEntries(
      Object.entries(base.agents).map(([name, agent]) => [name, { ...agent }]),
    ) as Config["agents"],
  };

  const has = (alias: string) => Boolean(clone.models[alias]);

  if (mode === "balanced") {
    if (has("local")) clone.orchestrator.model = "local";
    if (has("smart")) {
      for (const name of promotedAgents(clone)) {
        const agent = clone.agents[name];
        if (agent) agent.model = "smart";
      }
    }
    if (has("fast") && clone.agents[BaseAgent.Responder]) {
      clone.agents[BaseAgent.Responder].model = "fast";
    }
    return clone;
  }

  if (mode === "cloud") {
    if (has("smart")) clone.orchestrator.model = "smart";
    if (has("smart")) {
      for (const name of promotedAgents(clone)) {
        const agent = clone.agents[name];
        if (agent) agent.model = "smart";
      }
    }
    if (has("fast") && clone.agents[BaseAgent.Responder]) {
      clone.agents[BaseAgent.Responder].model = "fast";
    }
    return clone;
  }

  return base;
};
