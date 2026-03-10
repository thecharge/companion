import type { Config } from "@companion/config";
import type { Blackboard } from "@companion/core";
import { createLLMClient } from "@companion/llm";
import { loadSkillsDir, registerSkills } from "@companion/skills";
import type { ToolRegistry } from "@companion/tools";
import { resolvePromotedAgents, resolveResponderAgent, resolveSkillWorkerAgents } from "./role-policy";
import {
  PENDING_SKILL_KEY,
  type ProposedSkillSpec,
  buildSkillAcquisitionPrompt,
  createSkillFromProposal,
  isAffirmative,
  isNegative,
  normalizeSkillSpec,
} from "./skill-acquisition";

const proposalReply = (proposal: ProposedSkillSpec): string => {
  const implementationType = proposal.implementation_type === "guide" ? "guide" : "script";
  return [
    `I detected a reusable capability gap and propose a new skill: "${proposal.name}".`,
    `Reason: ${proposal.why}`,
    `Planned tool: ${proposal.tool_name} (${implementationType})`,
    "Reply 'yes' to create it now, or 'no' to continue without creating it.",
  ].join("\n");
};

export const handlePendingSkillProposal = async (params: {
  blackboard: Blackboard;
  userMessage: string;
  registry: ToolRegistry;
  cfg: Config;
}): Promise<string | null> => {
  const scratch = params.blackboard.read("scratchpad") as Record<string, unknown>;
  const pendingRaw = scratch[PENDING_SKILL_KEY];
  if (!pendingRaw || typeof pendingRaw !== "object") return null;

  const pending = normalizeSkillSpec(pendingRaw as Partial<ProposedSkillSpec>);

  if (isAffirmative(params.userMessage)) {
    try {
      const created = await createSkillFromProposal(pending);
      const loadedSkills = await loadSkillsDir("./skills");
      await registerSkills(loadedSkills, params.registry);

      const candidateAgents = new Set<string>([
        resolveResponderAgent(params.cfg),
        ...resolvePromotedAgents(params.cfg),
        ...resolveSkillWorkerAgents(params.cfg),
      ]);

      for (const agentName of candidateAgents) {
        const agent = params.cfg.agents[agentName];
        if (!agent) continue;
        if (!agent.tools.includes(created.spec.tool_name)) {
          agent.tools.push(created.spec.tool_name);
        }
      }

      params.blackboard.setScratchpad(PENDING_SKILL_KEY, null);
      params.blackboard.appendObservation(`Created skill ${created.spec.name} at ${created.path}`);
      const implementationType = created.spec.implementation_type === "guide" ? "guide" : "script";
      return `Created skill "${created.spec.name}" with tool "${created.spec.tool_name}" (${implementationType}) at ${created.path}. It is now registered and available for this session.`;
    } catch (error) {
      params.blackboard.setScratchpad(PENDING_SKILL_KEY, null);
      return `Skill creation failed: ${String(error)}`;
    }
  }

  if (isNegative(params.userMessage)) {
    params.blackboard.setScratchpad(PENDING_SKILL_KEY, null);
    return "Understood. I cancelled that proposed skill acquisition.";
  }

  return `Pending skill proposal: "${pending.name}" (${pending.description}). Reply with 'yes' to create it or 'no' to cancel.`;
};

export const maybeProposeSkillAcquisition = async (params: {
  runtimeCfg: Config;
  orchCfg: Config["models"][string];
  blackboard: Blackboard;
  userMessage: string;
  signal?: AbortSignal;
  registry: ToolRegistry;
  allowProposal: boolean;
  defaultProposal: ProposedSkillSpec;
}): Promise<string | null> => {
  if (!params.allowProposal) return null;

  const scratch = params.blackboard.read("scratchpad") as Record<string, unknown>;
  if (scratch[PENDING_SKILL_KEY]) return null;

  if (params.defaultProposal) {
    const explicitIntent = /\b(create|add|build|generate|acquire)\s+(a\s+)?skill\b/i.test(params.userMessage);
    if (explicitIntent) {
      params.blackboard.setScratchpad(PENDING_SKILL_KEY, params.defaultProposal);
      params.blackboard.appendDecision(0, "propose_skill", params.defaultProposal.name, params.defaultProposal.why);
      return proposalReply(params.defaultProposal);
    }
  }

  const toolNames = params.registry.list().map((tool) => tool.function.name);
  const orchLLM = createLLMClient(params.orchCfg);

  try {
    const res = await orchLLM.chat({
      messages: [
        { role: "system", content: buildSkillAcquisitionPrompt(params.userMessage, toolNames) },
        {
          role: "user",
          content: `Mode: ${params.runtimeCfg.mode.default}. Decide if a reusable new skill should be acquired for this request.`,
        },
      ],
      json_mode: params.orchCfg.provider === "ollama",
      signal: params.signal,
    });

    const raw = res.choices[0]?.message.content ?? "";
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as { should_acquire?: boolean } & Partial<ProposedSkillSpec>;
    if (!parsed.should_acquire) return null;

    const proposal = normalizeSkillSpec(parsed);
    params.blackboard.setScratchpad(PENDING_SKILL_KEY, proposal);
    params.blackboard.appendDecision(0, "propose_skill", proposal.name, proposal.why);
    return proposalReply(proposal);
  } catch {
    return null;
  }
};
