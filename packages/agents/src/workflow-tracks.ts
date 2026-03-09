import type { Config } from "@companion/config";
import { DEFAULT_WORKFLOW_PLANS, OPERATIONS_TRACK_SIGNALS, PRODUCT_TRACK_SIGNALS } from "./policy-config";

export type WorkflowTrack = "standard" | string;

const fallbackTrack = (message: string): WorkflowTrack => {
  const q = message.toLowerCase();

  if (OPERATIONS_TRACK_SIGNALS.some((signal) => q.includes(signal))) return "operations";
  if (PRODUCT_TRACK_SIGNALS.some((signal) => q.includes(signal))) return "product_delivery";
  return "standard";
};

export const detectWorkflowTrack = (message: string, cfg?: Config): WorkflowTrack => {
  const lower = message.toLowerCase();
  const configured = cfg?.orchestrator.workflow_tracks ?? {};
  for (const [name, track] of Object.entries(configured)) {
    if ((track.triggers ?? []).some((trigger) => lower.includes(trigger.toLowerCase()))) {
      return name;
    }
  }
  return fallbackTrack(message);
};

export const workflowPlan = (track: WorkflowTrack, cfg: Config): string[] => {
  if (track !== "standard") {
    const configuredStages = cfg.orchestrator.workflow_tracks[track]?.stages ?? [];
    const configuredPlan = configuredStages.filter((name) => Boolean(cfg.agents[name]));
    if (configuredPlan.length) return configuredPlan;
  }

  const productPlan = [...DEFAULT_WORKFLOW_PLANS.product_delivery];
  const opsPlan = [...DEFAULT_WORKFLOW_PLANS.operations];
  const preferred = track === "product_delivery" ? productPlan : track === "operations" ? opsPlan : [];
  const defaultPlan = preferred.filter((name) => Boolean(cfg.agents[name]));
  if (defaultPlan.length) return defaultPlan;

  const fallback = [...DEFAULT_WORKFLOW_PLANS.fallback].filter((name) => Boolean(cfg.agents[name]));
  return fallback.length ? fallback : Object.keys(cfg.agents).slice(0, 1);
};
