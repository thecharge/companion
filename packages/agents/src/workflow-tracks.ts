import type { Config } from "@companion/config";

export type WorkflowTrack = "standard" | string;

function fallbackTrack(message: string): WorkflowTrack {
  const q = message.toLowerCase();
  const productSignals = [
    "prd",
    "product requirement",
    "requirements",
    "roadmap",
    "feature spec",
    "acceptance criteria",
    "delivery plan",
  ];
  const opsSignals = [
    "incident",
    "outage",
    "operations",
    "runbook",
    "sre",
    "deployment",
    "rollback",
    "release",
    "postmortem",
  ];

  if (opsSignals.some((signal) => q.includes(signal))) return "operations";
  if (productSignals.some((signal) => q.includes(signal))) return "product_delivery";
  return "standard";
}

export function detectWorkflowTrack(message: string, cfg?: Config): WorkflowTrack {
  const lower = message.toLowerCase();
  const configured = cfg?.orchestrator.workflow_tracks ?? {};
  for (const [name, track] of Object.entries(configured)) {
    if ((track.triggers ?? []).some((trigger) => lower.includes(trigger.toLowerCase()))) {
      return name;
    }
  }
  return fallbackTrack(message);
}

export function workflowPlan(track: WorkflowTrack, cfg: Config): string[] {
  if (track !== "standard") {
    const configuredStages = cfg.orchestrator.workflow_tracks[track]?.stages ?? [];
    const configuredPlan = configuredStages.filter((name) => Boolean(cfg.agents[name]));
    if (configuredPlan.length) return configuredPlan;
  }

  const productPlan = ["planner", "prd_designer", "delivery_manager", "engineer", "responder"];
  const opsPlan = ["planner", "operations_commander", "analyst", "engineer", "responder"];
  const preferred = track === "product_delivery" ? productPlan : track === "operations" ? opsPlan : [];
  const defaultPlan = preferred.filter((name) => Boolean(cfg.agents[name]));
  if (defaultPlan.length) return defaultPlan;

  const fallback = ["analyst", "engineer", "responder"].filter((name) => Boolean(cfg.agents[name]));
  return fallback.length ? fallback : Object.keys(cfg.agents).slice(0, 1);
}
