import type { Config } from "@companion/config";
import { INTENT_ROUTE_POLICIES } from "./policy-config";

const agentHasAllTools = (agent: { tools: string[] }, requiredTools: string[]): boolean => {
  return requiredTools.every((tool) => agent.tools.includes(tool));
};

export const resolveIntentAgent = (message: string, cfg: Config): string | null => {
  for (const route of INTENT_ROUTE_POLICIES) {
    const matched = route.matchers.some((matcher) => matcher.test(message));
    if (!matched) continue;

    if (route.preferredAgent) {
      const preferred = cfg.agents[route.preferredAgent];
      if (preferred && agentHasAllTools(preferred, route.requiredTools)) {
        return route.preferredAgent;
      }
    }

    for (const [name, agent] of Object.entries(cfg.agents)) {
      if (agentHasAllTools(agent, route.requiredTools)) {
        return name;
      }
    }
  }

  return null;
};
