import { BaseAgent } from "./agent-ids";

export interface IntentRoutePolicy {
  matchers: RegExp[];
  requiredTools: string[];
  preferredAgent?: BaseAgent;
}

export const PRODUCT_TRACK_SIGNALS = [
  "prd",
  "product requirement",
  "requirements",
  "roadmap",
  "feature spec",
  "acceptance criteria",
  "delivery plan",
] as const;

export const OPERATIONS_TRACK_SIGNALS = [
  "incident",
  "outage",
  "operations",
  "runbook",
  "sre",
  "deployment",
  "rollback",
  "release",
  "postmortem",
] as const;

export const DEFAULT_WORKFLOW_PLANS = {
  product_delivery: [
    BaseAgent.Planner,
    BaseAgent.PrdDesigner,
    BaseAgent.DeliveryManager,
    BaseAgent.Engineer,
    BaseAgent.Responder,
  ],
  operations: [
    BaseAgent.Planner,
    BaseAgent.OperationsCommander,
    BaseAgent.Analyst,
    BaseAgent.Engineer,
    BaseAgent.Responder,
  ],
  fallback: [BaseAgent.Analyst, BaseAgent.Engineer, BaseAgent.Responder],
} as const;

export const INTENT_ROUTE_POLICIES: IntentRoutePolicy[] = [
  {
    matchers: [/\b(weather|temperature|forecast|rain|wind|humidity)\b/i, /\bwhat(?:'s| is)\s+the\s+weather\b/i],
    requiredTools: ["weather_lookup"],
    preferredAgent: BaseAgent.Analyst,
  },
  {
    matchers: [
      /\b(system\s+load|cpu\s+load|load\s+average|uptime|memory\s+usage|disk\s+usage|top)\b/i,
      /\b(current\s+load|host\s+load)\b/i,
    ],
    requiredTools: ["run_shell"],
    preferredAgent: BaseAgent.Engineer,
  },
  {
    matchers: [
      /\b(create|edit|modify|update|write|append|rename|delete)\b.*\b(file|files|config|source|code)\b/i,
      /\bmake\b.*\bfile\b/i,
      /\bpatch\b.*\bfile\b/i,
    ],
    requiredTools: ["write_file"],
    preferredAgent: BaseAgent.Engineer,
  },
];
