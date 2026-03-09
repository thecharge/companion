import type { Config } from "@companion/config";
import { type Blackboard, Logger, type SessionId, bus } from "@companion/core";
import type { DB } from "@companion/db";
import { createLLMClient } from "@companion/llm";
import type { MemoryService } from "@companion/memory";
import { loadSkillsDir, registerSkills } from "@companion/skills";
import type { ToolContext, ToolRegistry } from "@companion/tools";
import { AgentRunner } from "./agent-runner";
import { hasFileTaskIntent, hasSkillIntent, hasSystemTaskIntent } from "./patterns";
import { buildOrchestratorPrompt } from "./prompts";
import {
  PENDING_SKILL_KEY,
  type ProposedSkillSpec,
  buildSkillAcquisitionPrompt,
  createSkillFromProposal,
  defaultSkillProposalFromMessage,
  isAffirmative,
  isNegative,
  normalizeSkillSpec,
} from "./skill-acquisition";
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

function hasExplicitSkillIntent(message: string): boolean {
  return hasSkillIntent(message);
}

function inferForcedAgent(message: string, cfg: Config): string | null {
  const engineer = cfg.agents.engineer;
  if (!engineer) return null;

  const hasRunShell = engineer.tools.includes("run_shell");
  const hasWriteFile = engineer.tools.includes("write_file");
  if (hasSystemTaskIntent(message) && hasRunShell) return "engineer";
  if (hasFileTaskIntent(message) && (hasWriteFile || hasRunShell)) return "engineer";
  return null;
}

interface DirectToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseDirectToolCalls(raw: string): DirectToolCall[] | null {
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(text) as unknown;

    if (Array.isArray(parsed)) {
      const calls = parsed
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const tool = String((entry as Record<string, unknown>).tool ?? "").trim();
          const args = (entry as Record<string, unknown>).args;
          if (!tool || !args || typeof args !== "object" || Array.isArray(args)) return null;
          return { tool, args: args as Record<string, unknown> };
        })
        .filter((entry): entry is DirectToolCall => Boolean(entry));
      return calls.length ? calls : null;
    }

    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.tool_calls)) {
      const calls = obj.tool_calls
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const tool = String((entry as Record<string, unknown>).tool ?? "").trim();
          const args = (entry as Record<string, unknown>).args;
          if (!tool || !args || typeof args !== "object" || Array.isArray(args)) return null;
          return { tool, args: args as Record<string, unknown> };
        })
        .filter((entry): entry is DirectToolCall => Boolean(entry));
      return calls.length ? calls : null;
    }

    if (typeof obj.tool === "string" && obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)) {
      return [{ tool: obj.tool, args: obj.args as Record<string, unknown> }];
    }

    return null;
  } catch {
    return null;
  }
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
    const runtimeCfg = this.runtimeConfig(mode);

    if (signal?.aborted) return { reply: "", blackboard, stopped_reason: "cancelled" };

    const directToolReply = await this.tryDirectToolExecution(session_id, user_message, working_dir, runtimeCfg);
    if (directToolReply) {
      blackboard.appendObservation(`[direct-tools] ${directToolReply.slice(0, 400)}`);
      return { reply: directToolReply, blackboard, stopped_reason: "done" };
    }

    const orchAlias = runtimeCfg.orchestrator.model;
    const orchCfg = runtimeCfg.models[orchAlias];
    if (!orchCfg) throw new Error(`Orchestrator model alias not found: ${orchAlias}`);

    const pendingHandled = await this.handlePendingSkillProposal(blackboard, user_message);
    if (pendingHandled) {
      return { reply: pendingHandled, blackboard, stopped_reason: "done" };
    }

    const proposalReply = await this.maybeProposeSkillAcquisition(
      runtimeCfg,
      orchCfg,
      blackboard,
      user_message,
      signal,
    );
    if (proposalReply) {
      return { reply: proposalReply, blackboard, stopped_reason: "done" };
    }

    const workflowTrack = detectWorkflowTrackInternal(user_message, runtimeCfg);
    if (workflowTrack !== "standard") {
      return this.runWorkflowTrack(workflowTrack, runtimeCfg, params);
    }

    blackboard.appendDecision(0, "start", "orchestrator", user_message.slice(0, 80));

    let decision: { action: string; target?: string; reason?: string };
    const forcedAgent = inferForcedAgent(user_message, runtimeCfg);
    if (forcedAgent) {
      decision = {
        action: "run_agent",
        target: forcedAgent,
        reason: "heuristic: explicit system/file task requires tool-capable engineer",
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
          const fallback = Object.keys(runtimeCfg.agents)[0] ?? "responder";
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

    const preferredTarget = decision.target ?? "responder";
    const targetName = runtimeCfg.agents[preferredTarget]
      ? preferredTarget
      : (Object.keys(runtimeCfg.agents).find((name) => name === "responder") ??
        Object.keys(runtimeCfg.agents)[0] ??
        "responder");

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

    if (targetName === "responder" || !agentResult.reply) {
      return { reply: agentResult.reply, blackboard, stopped_reason: agentResult.stopped_reason };
    }

    const respDef = runtimeCfg.agents.responder;
    if (!respDef) {
      return { reply: agentResult.reply, blackboard, stopped_reason: "done" };
    }

    bus.emit({
      type: "orchestrator_decision",
      session_id,
      ts: new Date(),
      payload: { round: 2, action: "reply", target: "responder" },
    });

    const respRunner = new AgentRunner("responder", runtimeCfg, this.registry, this.memory, this.db);
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

  private async handlePendingSkillProposal(blackboard: Blackboard, userMessage: string): Promise<string | null> {
    const scratch = blackboard.read("scratchpad") as Record<string, unknown>;
    const pendingRaw = scratch[PENDING_SKILL_KEY];
    if (!pendingRaw || typeof pendingRaw !== "object") return null;

    const pending = normalizeSkillSpec(pendingRaw as Partial<ProposedSkillSpec>);

    if (isAffirmative(userMessage)) {
      try {
        const created = await createSkillFromProposal(pending);
        const loadedSkills = await loadSkillsDir("./skills");
        await registerSkills(loadedSkills, this.registry);
        this.enableToolForWorkers(created.spec.tool_name);

        blackboard.setScratchpad(PENDING_SKILL_KEY, null);
        blackboard.appendObservation(`Created skill ${created.spec.name} at ${created.path}`);
        return `Created skill "${created.spec.name}" with tool "${created.spec.tool_name}" at ${created.path}. It is now registered and available for this session.`;
      } catch (error) {
        blackboard.setScratchpad(PENDING_SKILL_KEY, null);
        return `Skill creation failed: ${String(error)}`;
      }
    }

    if (isNegative(userMessage)) {
      blackboard.setScratchpad(PENDING_SKILL_KEY, null);
      return "Understood. I cancelled that proposed skill acquisition.";
    }

    return `Pending skill proposal: "${pending.name}" (${pending.description}). Reply with 'yes' to create it or 'no' to cancel.`;
  }

  private async maybeProposeSkillAcquisition(
    runtimeCfg: Config,
    orchCfg: Config["models"][string],
    blackboard: Blackboard,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const explicit = hasExplicitSkillIntent(userMessage);
    if (!explicit && !shouldConsiderSkillAcquisition(userMessage, blackboard)) return null;

    const scratch = blackboard.read("scratchpad") as Record<string, unknown>;
    if (scratch[PENDING_SKILL_KEY]) return null;

    if (explicit) {
      const proposal = normalizeSkillSpec(defaultSkillProposalFromMessage(userMessage));
      blackboard.setScratchpad(PENDING_SKILL_KEY, proposal);
      blackboard.appendDecision(0, "propose_skill", proposal.name, proposal.why);
      return [
        `I detected a reusable capability gap and propose a new skill: "${proposal.name}".`,
        `Reason: ${proposal.why}`,
        `Planned tool: ${proposal.tool_name}`,
        "Reply 'yes' to create it now, or 'no' to continue without creating it.",
      ].join("\n");
    }

    const toolNames = this.registry.list().map((tool) => tool.function.name);
    const orchLLM = createLLMClient(orchCfg);

    try {
      const res = await orchLLM.chat({
        messages: [
          { role: "system", content: buildSkillAcquisitionPrompt(userMessage, toolNames) },
          {
            role: "user",
            content: `Mode: ${runtimeCfg.mode.default}. Decide if a reusable new skill should be acquired for this request.`,
          },
        ],
        json_mode: orchCfg.provider === "ollama",
        signal,
      });

      const raw = res.choices[0]?.message.content ?? "";
      const cleaned = raw
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(cleaned) as { should_acquire?: boolean } & Partial<ProposedSkillSpec>;
      if (!parsed.should_acquire) return null;

      const proposal = normalizeSkillSpec(parsed);
      blackboard.setScratchpad(PENDING_SKILL_KEY, proposal);
      blackboard.appendDecision(0, "propose_skill", proposal.name, proposal.why);

      return [
        `I detected a reusable capability gap and propose a new skill: "${proposal.name}".`,
        `Reason: ${proposal.why}`,
        `Planned tool: ${proposal.tool_name}`,
        "Reply 'yes' to create it now, or 'no' to continue without creating it.",
      ].join("\n");
    } catch {
      return null;
    }
  }

  private enableToolForWorkers(toolName: string): void {
    for (const agentName of ["engineer", "analyst"] as const) {
      const agent = this.cfg.agents[agentName];
      if (!agent) continue;
      if (!agent.tools.includes(toolName)) {
        agent.tools.push(toolName);
      }
    }
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

      if (result.stopped_reason === "cancelled") return { reply: "", blackboard, stopped_reason: "cancelled" };
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

  private runtimeConfig(mode: string): Config {
    if (mode === "local") return this.cfg;

    const clone: Config = {
      ...this.cfg,
      orchestrator: { ...this.cfg.orchestrator },
      agents: Object.fromEntries(
        Object.entries(this.cfg.agents).map(([name, agent]) => [name, { ...agent }]),
      ) as Config["agents"],
    };

    const has = (alias: string) => Boolean(clone.models[alias]);

    if (mode === "balanced") {
      if (has("local")) clone.orchestrator.model = "local";
      for (const name of [
        "analyst",
        "planner",
        "engineer",
        "prd_designer",
        "delivery_manager",
        "operations_commander",
        "researcher",
      ]) {
        if (has("smart") && clone.agents[name]) clone.agents[name].model = "smart";
      }
      if (has("fast") && clone.agents.responder) clone.agents.responder.model = "fast";
      return clone;
    }

    if (mode === "cloud") {
      if (has("smart")) clone.orchestrator.model = "smart";
      for (const name of [
        "analyst",
        "planner",
        "engineer",
        "prd_designer",
        "delivery_manager",
        "operations_commander",
        "researcher",
      ]) {
        if (has("smart") && clone.agents[name]) clone.agents[name].model = "smart";
      }
      if (has("fast") && clone.agents.responder) clone.agents.responder.model = "fast";
      return clone;
    }

    return this.cfg;
  }

  private async tryDirectToolExecution(
    sessionId: SessionId,
    userMessage: string,
    workingDir: string,
    runtimeCfg: Config,
  ): Promise<string | null> {
    const directCalls = parseDirectToolCalls(userMessage);
    if (!directCalls?.length) return null;

    const toolContext: ToolContext = {
      session_id: sessionId,
      working_dir: workingDir,
      db: this.db,
      cfg: runtimeCfg,
    };

    const outputs: string[] = [];
    for (let i = 0; i < directCalls.length; i++) {
      const call = directCalls[i];
      if (!call) continue;

      if (!this.registry.get(call.tool)) {
        outputs.push(`[error] unknown tool: ${call.tool}`);
        continue;
      }

      const result = await this.registry.run(
        {
          id: `direct_${Date.now()}_${i}`,
          tool_name: call.tool,
          args: call.args,
        },
        toolContext,
      );

      if (result.error) {
        outputs.push(`[error] ${call.tool}: ${result.error}`);
      } else {
        outputs.push(`[ok] ${call.tool}: ${result.result ?? "done"}`);
      }
    }

    return outputs.join("\n");
  }
}
