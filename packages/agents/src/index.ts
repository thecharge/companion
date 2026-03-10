import type { Config } from "@companion/config";
import { type Blackboard, Logger, bus } from "@companion/core";
import type { DB } from "@companion/db";
import type { MemoryService } from "@companion/memory";
import type { ToolRegistry } from "@companion/tools";
import { AgentRunner } from "./agent-runner";
import { executeDirectToolCalls } from "./direct-tool-execution";
import { resolveIntentAgent } from "./intent-routing";
import { decideOrchestratorAction } from "./orchestrator-decision-strategy";
import { hasCompositeOpsIntent, hasSkillIntent } from "./patterns";
import { resolveResponderAgent } from "./role-policy";
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

export const detectWorkflowTrack = (message: string, cfg?: Config): WorkflowTrack => {
  return detectWorkflowTrackInternal(message, cfg);
};

const shouldConsiderSkillAcquisition = (message: string, blackboard: Blackboard): boolean => {
  const explicitIntent = hasSkillIntent(message);
  if (explicitIntent) return true;

  if (hasCompositeOpsIntent(message)) {
    return true;
  }

  const rejections = blackboard.read("rejections");
  return Array.isArray(rejections) && rejections.length >= 3;
};

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
    const responder = resolveResponderAgent(runtimeCfg);

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

    const forcedAgent = resolveIntentAgent(user_message, runtimeCfg);
    let decision: { action: string; target?: string; reason?: string };
    try {
      decision = await decideOrchestratorAction({
        runtimeCfg,
        forcedAgent,
        blackboard,
        mode,
        registry: this.registry,
        userMessage: user_message,
        responder,
        signal,
      });
    } catch (error) {
      const msg = String(error);
      if (signal?.aborted || msg.includes("AbortError")) {
        return { reply: "", blackboard, stopped_reason: "cancelled" };
      }
      throw error;
    }

    bus.emit({
      type: "orchestrator_decision",
      session_id,
      ts: new Date(),
      payload: { round: 1, action: decision.action, target: decision.target },
    });
    blackboard.appendDecision(1, decision.action, decision.target ?? "", decision.reason ?? "");

    const preferredTarget = decision.target ?? responder;
    const targetName = runtimeCfg.agents[preferredTarget]
      ? preferredTarget
      : (Object.keys(runtimeCfg.agents).find((name) => name === responder) ??
        Object.keys(runtimeCfg.agents)[0] ??
        responder);

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

    if (targetName === responder || !agentResult.reply) {
      return { reply: agentResult.reply, blackboard, stopped_reason: agentResult.stopped_reason };
    }

    if (!runtimeCfg.agents[responder]) {
      return { reply: agentResult.reply, blackboard, stopped_reason: "done" };
    }

    bus.emit({
      type: "orchestrator_decision",
      session_id,
      ts: new Date(),
      payload: { round: 2, action: "reply", target: responder },
    });

    const responderRunner = new AgentRunner(responder, runtimeCfg, this.registry, this.memory, this.db);
    let responderResult: Awaited<ReturnType<typeof responderRunner.run>>;

    try {
      responderResult = await responderRunner.run({
        session_id,
        blackboard,
        user_message,
        history,
        working_dir,
        signal,
      });
    } catch {
      return { reply: agentResult.reply, blackboard, stopped_reason: "done" };
    }

    if (responderResult.stopped_reason === "cancelled") {
      return { reply: "", blackboard, stopped_reason: "cancelled" };
    }

    return {
      reply: responderResult.reply || agentResult.reply,
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
      return {
        reply: `No configured workflow stages found for track '${track}'.`,
        blackboard,
        stopped_reason: "error",
      };
    }

    blackboard.appendDecision(0, "workflow_track", track, plan.join(" -> "));
    let stagePrompt = user_message;
    let finalReply = "";

    for (let i = 0; i < plan.length; i++) {
      const agentName = plan[i] ?? resolveResponderAgent(runtimeCfg);
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
