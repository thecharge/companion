import type { Config } from "@companion/config";

interface IntentRoute {
  matchers: RegExp[];
  requiredTools: string[];
  preferredAgent?: string;
}

const compileKeywordMatcher = (keyword: string): RegExp => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
};

const configuredIntentRoutes = (cfg: Config): IntentRoute[] => {
  return cfg.orchestrator.intent_routes
    .map((route) => ({
      matchers: route.keywords.map(compileKeywordMatcher),
      requiredTools: route.required_tools,
      preferredAgent: route.preferred_agent,
    }))
    .filter((route) => route.matchers.length > 0 && route.requiredTools.length > 0);
};

const agentHasAllTools = (agent: { tools: string[] }, requiredTools: string[]): boolean => {
  return requiredTools.every((tool) => agent.tools.includes(tool));
};

export const resolveIntentAgent = (message: string, cfg: Config): string | null => {
  const routes = configuredIntentRoutes(cfg);
  if (!routes.length) return null;

  for (const route of routes) {
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
