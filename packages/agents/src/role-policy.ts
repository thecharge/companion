import type { Config } from "@companion/config";

const existing = (cfg: Config, names: string[]): string[] => {
  return names.filter((name) => Boolean(cfg.agents[name]));
};

export const resolveResponderAgent = (cfg: Config): string => {
  const configured = cfg.orchestrator.roles?.responder;
  if (configured && cfg.agents[configured]) return configured;
  return Object.keys(cfg.agents)[0] ?? configured ?? "";
};

export const resolvePromotedAgents = (cfg: Config): string[] => {
  const configured = existing(cfg, cfg.orchestrator.roles?.promoted_agents ?? []);
  if (configured.length) return configured;

  const responder = resolveResponderAgent(cfg);
  return Object.keys(cfg.agents).filter((name) => name !== responder);
};

export const resolveSkillWorkerAgents = (cfg: Config): string[] => {
  const configured = existing(cfg, cfg.orchestrator.roles?.skill_worker_agents ?? []);
  if (configured.length) return configured;

  const responder = resolveResponderAgent(cfg);
  return Object.entries(cfg.agents)
    .filter(([name, agent]) => name !== responder && agent.tools.length > 0)
    .map(([name]) => name);
};
