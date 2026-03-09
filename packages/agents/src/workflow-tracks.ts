import type { Config } from "@companion/config";

export type WorkflowTrack = "standard" | string;

export const detectWorkflowTrack = (message: string, cfg?: Config): WorkflowTrack => {
  const lower = message.toLowerCase();
  const configured = cfg?.orchestrator.workflow_tracks ?? {};
  for (const [name, track] of Object.entries(configured)) {
    if ((track.triggers ?? []).some((trigger) => lower.includes(trigger.toLowerCase()))) {
      return name;
    }
  }
  return "standard";
};

export const workflowPlan = (track: WorkflowTrack, cfg: Config): string[] => {
  if (track === "standard") return [];
  const configuredStages = cfg.orchestrator.workflow_tracks[track]?.stages ?? [];
  return configuredStages.filter((name) => Boolean(cfg.agents[name]));
};
