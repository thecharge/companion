import type { Config } from "@companion/config";
import { type Blackboard, Logger, bus } from "@companion/core";
import type { DB } from "@companion/db";
import { createLLMClient } from "@companion/llm";
import type { MemoryService } from "@companion/memory";
import type { ToolRegistry } from "@companion/tools";
import { BaseAgent } from "./agent-ids";
import { AgentRunner } from "./agent-runner";
import { executeDirectToolCalls } from "./direct-tool-execution";
import { resolveIntentAgent } from "./intent-routing";
import { hasSkillIntent } from "./patterns";
import { buildOrchestratorPrompt } from "./prompts";
import { buildRuntimeConfig } from "./runtime-config";
import { defaultSkillProposalFromMessage, normalizeSkillSpec } from "./skill-acquisition";
import { handlePendingSkillProposal, maybeProposeSkillAcquisition } from "./skill-proposal-flow";
import type { AgentRunResult, OrchestratorParams } from "./types";
import {
  type WorkflowTrack,
  detectWorkflowTrack as detectWorkflowTrackInternal,
  workflowPlan,
} from "./workflow-tracks";

const log = new Logger("agents");

export function detectWorkflowTrack(message: string): WorkflowTrack {
  return detectWorkflowTrackInternal(message);
}

function shouldConsiderSkillAcquisition(message: string, blackboard: Blackboard): boolean {
  const explicitIntent = hasSkillIntent(message);
  if (explicitIntent) return true;

  const rejections = blackboard.read("rejections");
  return Array.isArray(rejections) && rejections.length >= 3;
}

export class SessionProcessor {
  constructor(
    private cfg: Config,
    private registry: ToolRegistry,
    private memory: MemoryService,
    private db: DB,
  ) {}

  async handleMessage(params: OrchestratorParams): Promise<AgentRunResult> {
    const { session_id, blackboard, user_message, history, working_dir, mode, signal } = params;
    const runtimeCfg = buildRuntimeConfig(this.cfg, mode);

    if (signal?.aborted) {
      return { reply: "", blackboard, stopped_reason: "cancelled" };
    }

    const directToolReply = await executeDirectToolCalls({
      sessionId: session_id,
      userMessage: user_message,
      workingDir: working_dir,
      runtimeCfg,
      registry: this.registry,
      db: this.db,
    });
    if (directToolReply) {
      blackboard.appendObservation(`[direct-tools] ${directToolReply.slice(0, 400)}`);
      return { reply: directToolReply, blackboard, stopped_reason: "done" };
    }

    const orchAlias = runtimeCfg.orchestrator.model;
    const orchCfg = runtimeCfg.models[orchAlias];
    if (!orchCfg) throw new Error(`Orchestrator model alias not found: ${orchAlias}`);

    const pendingHandled = await handlePendingSkillProposal({
      blackboard,
      userMessage: user_message,
      registry: this.registry,
      cfg: this.cfg,
    });
    if (pendingHandled) {
      return { reply: pendingHandled, blackboard, stopped_reason: "done" };
    }

    const proposalReply = await maybeProposeSkillAcquisition({
      runtimeCfg,
      orchCfg,
      blackboard,
      userMessage: user_message,
      signal,
      registry: this.registry,
      allowProposal: shouldConsiderSkillAcquisition(user_message, blackboard),
      defaultProposal: normalizeSkillSpec(defaultSkillProposalFromMessage(user_message)),
    });
    if (proposalReply) {
      return { reply: proposalReply, blackboard, stopped_reason: "done" };
    }

    const workflowTrack = detectWorkflowTrackInternal(user_message, runtimeCfg);
    if (workflowTrack !== "standard") {
      return this.runWorkflowTrack(workflowTrack, runtimeCfg, params);
    }

    blackboard.appendDecision(0, "start", "orchestrator", user_message.slice(0, 80));

    let decision: { action: string; target?: string; reason?: string };
    const forcedAgent = resolveIntentAgent(user_message, runtimeCfg);
    if (forcedAgent) {
      decision = {
        action: "run_agent",
        target: forcedAgent,
        reason: "intent route: required tool capability detected",
      };
    } else {
      const orchLLM = createLLMClient(orchCfg);
      try {
        const res = await orchLLM.chat({
          messages: [
            { role: "system", content: buildOrchestratorPrompt(runtimeCfg, this.registry, blackboard, mode) },
            { role: "user", content: user_message },
          ],
          json_mode: orchCfg.provider === "ollama",
          signal,
        });
        const raw = res.choices[0]?.message.content ?? "";
        const cleaned = raw
          .replace(/^```json\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        try {
          decision = JSON.parse(cleaned) as typeof decision;
        } catch {
          log.warn("Orchestrator non-JSON - defaulting to first configured agent", { raw: raw.slice(0, 80) });
          const fallback = Object.keys(runtimeCfg.agents)[0] ?? BaseAgent.Responder;
          decision = { action: "run_agent", target: fallback, reason: "parse fallback" };
        }
      } catch (e) {
        const msg = String(e);
        if (signal?.aborted || msg.includes("AbortError")) {
          return { reply: "", blackboard, stopped_reason: "cancelled" };
        }
        throw e;
      }
    }

    bus.emit({
      type: "orchestrator_decision",
      session_id,
      ts: new Date(),
      payload: { round: 1, action: decision.action, target: decision.target },
    });
    blackboard.appendDecision(1, decision.action, decision.target ?? "", decision.reason ?? "");

    const preferredTarget = decision.target ?? BaseAgent.Responder;
    const targetName = runtimeCfg.agents[preferredTarget]
      ? preferredTarget
      : (Object.keys(runtimeCfg.agents).find((name) => name === BaseAgent.Responder) ??
        Object.keys(runtimeCfg.agents)[0] ??
        BaseAgent.Responder);

    if (!runtimeCfg.agents[preferredTarget]) {
      log.warn(`Agent "${preferredTarget}" not defined - falling back to "${targetName}"`);
    }

    const runner = new AgentRunner(targetName, runtimeCfg, this.registry, this.memory, this.db);
    let agentResult: Awaited<ReturnType<typeof runner.run>>;

    try {
      agentResult = await runner.run({ session_id, blackboard, user_message, history, working_dir, signal });
    } catch (fatalErr) {
      const msg = String(fatalErr);
      log.error(`Fatal error from "${targetName}"`, fatalErr);
      bus.emit({ type: "error", session_id, ts: new Date(), payload: { error: msg } });
      return { reply: `Error: ${msg}`, blackboard, stopped_reason: "error" };
    }

    if (agentResult.stopped_reason === "cancelled") {
      return { reply: "", blackboard, stopped_reason: "cancelled" };
    }

    if (agentResult.reply) {
      blackboard.appendObservation(`[${targetName}] ${agentResult.reply.slice(0, 400)}`);
    }

    if (targetName === BaseAgent.Responder || !agentResult.reply) {
      return { reply: agentResult.reply, blackboard, stopped_reason: agentResult.stopped_reason };
    }

    const respDef = runtimeCfg.agents[BaseAgent.Responder];
    if (!respDef) {
      return { reply: agentResult.reply, blackboard, stopped_reason: "done" };
    }

    bus.emit({
      type: "orchestrator_decision",
      session_id,
      ts: new Date(),
      payload: { round: 2, action: "reply", target: BaseAgent.Responder },
    });

    const respRunner = new AgentRunner(BaseAgent.Responder, runtimeCfg, this.registry, this.memory, this.db);
    let respResult: Awaited<ReturnType<typeof respRunner.run>>;

    try {
      respResult = await respRunner.run({ session_id, blackboard, user_message, history, working_dir, signal });
    } catch {
      return { reply: agentResult.reply, blackboard, stopped_reason: "done" };
    }

    if (respResult.stopped_reason === "cancelled") {
      return { reply: "", blackboard, stopped_reason: "cancelled" };
    }

    return {
      reply: respResult.reply || agentResult.reply,
      blackboard,
      stopped_reason: "done",
    };
  }

  private async runWorkflowTrack(
    track: WorkflowTrack,
    runtimeCfg: Config,
    params: OrchestratorParams,
  ): Promise<AgentRunResult> {
    const { session_id, blackboard, user_message, history, working_dir, signal } = params;
    const plan = workflowPlan(track, runtimeCfg);
    if (!plan.length) {
      return { reply: "No configured agents available for workflow execution.", blackboard, stopped_reason: "error" };
    }

    blackboard.appendDecision(0, "workflow_track", track, plan.join(" -> "));
    let stagePrompt = user_message;
    let finalReply = "";

    for (let i = 0; i < plan.length; i++) {
      const agentName = plan[i] ?? "responder";
      bus.emit({
        type: "orchestrator_decision",
        session_id,
        ts: new Date(),
        payload: { round: i + 1, action: "run_agent", target: agentName, track },
      });

      const runner = new AgentRunner(agentName, runtimeCfg, this.registry, this.memory, this.db);
      const result = await runner.run({
        session_id,
        blackboard,
        user_message: stagePrompt,
        history,
        working_dir,
        signal,
      });

      if (result.stopped_reason === "cancelled") {
        return { reply: "", blackboard, stopped_reason: "cancelled" };
      }
      if (result.stopped_reason === "error") {
        return {
          reply: result.reply || `Workflow agent ${agentName} failed`,
          blackboard,
          stopped_reason: "error",
        };
      }

      if (result.reply) {
        finalReply = result.reply;
        blackboard.appendObservation(`[${agentName}] ${result.reply.slice(0, 500)}`);
        stagePrompt = [
          `Workflow track: ${track}`,
          `Original request: ${user_message}`,
          `Latest ${agentName} output:\n${result.reply}`,
          "Continue with your lane and handoff cleanly to the next agent.",
        ].join("\n\n");
      }
    }

    return { reply: finalReply, blackboard, stopped_reason: "done" };
  }
}
