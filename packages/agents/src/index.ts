/**
 * @companion/agents — v2
 *
 * Fixes vs previous version:
 *
 * 1. NO orchestrator re-evaluation after agent succeeds.
 *    The old code ran the orchestrator again after engineer, which caused qwen to
 *    route to analyst, then loop ×10. Now: engineer succeeds → responder → done.
 *
 * 2. AbortSignal threaded everywhere. Cancel mid-flight via WS {"type":"cancel"}.
 *
 * 3. Self-verify disabled. When orchestrator and agent use the same model,
 *    qwen2.5:3b verifying its own output is noise that randomly rejects valid answers.
 *
 * 4. ReAct recursion capped at depth=1. One recovery attempt, then use raw text.
 *
 * 5. Orchestrator only routes — runs ONCE to pick an agent, then waits for result.
 *    If result is good: responder. If bad (error/cancelled): abort. No loops.
 */

import type { Config } from "@companion/config";
import { type Blackboard, Logger, type SessionId, bus } from "@companion/core";
import type { DB } from "@companion/db";
import {
  type ChatMessage,
  type OAITool,
  createLLMClient,
  isToolCall,
  modelSupportsTools,
  stripThinking,
} from "@companion/llm";
import type { MemoryService } from "@companion/memory";
import { loadSkillsDir, registerSkills } from "@companion/skills";
import type { ToolContext, ToolRegistry } from "@companion/tools";
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

const log = new Logger("agents");

export type WorkflowTrack = "standard" | "product_delivery" | "operations";

export function detectWorkflowTrack(message: string): WorkflowTrack {
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

function shouldConsiderSkillAcquisition(message: string, blackboard: Blackboard): boolean {
  const q = message.toLowerCase();
  const explicitIntent =
    /(create|add|build|generate|acquire)\s+(a\s+)?skill\b/.test(q) ||
    /(teach|learn)\s+(this|that|new)\s+(capability|skill)\b/.test(q);
  if (explicitIntent) return true;

  const rejections = blackboard.read("rejections");
  return Array.isArray(rejections) && rejections.length >= 3;
}

function hasExplicitSkillIntent(message: string): boolean {
  const q = message.toLowerCase();
  return (
    /(create|add|build|generate|acquire)\s+(a\s+)?skill\b/.test(q) ||
    /(teach|learn)\s+(this|that|new)\s+(capability|skill)\b/.test(q)
  );
}

// ── Types ─────────────────────────────────────────────────────

export interface AgentRunParams {
  session_id: SessionId;
  blackboard: Blackboard;
  user_message: string;
  history: ChatMessage[];
  working_dir: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  reply: string;
  blackboard: Blackboard;
  stopped_reason: "done" | "max_turns" | "error" | "cancelled";
}

// ── Orchestrator prompt — fires once, picks one agent ─────────

function buildOrchestratorPrompt(cfg: Config, registry: ToolRegistry, bb: Blackboard, mode: string): string {
  const agents = Object.entries(cfg.agents).map(([name, agent]) => {
    const toolList = agent.tools.length
      ? agent.tools
          .map((toolName) => {
            const schema = registry.get(toolName)?.schema;
            const desc = schema?.function.description ?? "no description";
            return `${toolName} (${desc})`;
          })
          .join(", ")
      : "none";

    return `- ${name}: ${agent.description}\n  model_alias: ${agent.model}\n  tools: ${toolList}`;
  });

  const targets = Object.keys(cfg.agents)
    .map((name) => `{"action":"run_agent","target":"${name}","reason":"one line"}`)
    .join("\n");

  return `You are a router. Pick ONE configured agent for this task. Reply with ONLY valid JSON.

Mode: ${mode}
Goal: ${bb.goal || "not set"}

Configured agents:
${agents.join("\n")}

Routing rules:
- Use the configured agent definitions above; do not invent capabilities.
- Choose the agent whose declared tools are best aligned with the request.
- Prefer dedicated data tools over generic shell commands when both exist.
- If no tool use is needed, choose the best direct-response agent.

Reply ONLY with one of:
${targets}`;
}

// ── AgentRunner ───────────────────────────────────────────────

class AgentRunner {
  constructor(
    private agentName: string,
    private cfg: Config,
    private registry: ToolRegistry,
    private memory: MemoryService,
    private db: DB,
  ) {}

  async run(params: AgentRunParams): Promise<{
    reply: string;
    stopped_reason: "done" | "max_turns" | "error" | "cancelled";
  }> {
    const { signal } = params;
    const agentCfg = this.cfg.agents[this.agentName];
    if (!agentCfg) throw new Error(`Unknown agent: ${this.agentName}`);

    const modelAlias = agentCfg.model;
    const modelCfg = this.cfg.models[modelAlias];
    if (!modelCfg) throw new Error(`Unknown model alias: ${modelAlias}`);

    let activeModelAlias = modelAlias;
    let activeModelCfg = modelCfg;
    let llm = createLLMClient(activeModelCfg);
    let usedAuthFallback = false;
    const maxTurns = agentCfg.max_turns;
    const tools = agentCfg.tools
      .map((name) => this.registry.get(name)?.schema)
      .filter((t): t is OAITool => t !== undefined);

    const isReAct = !modelSupportsTools(modelCfg.model) && tools.length > 0;
    const systemPrompt = [
      `You are the ${this.agentName} agent. ${agentCfg.description}`,
      `Goal: ${params.blackboard.goal || params.user_message}`,
      `Context:\n${params.blackboard.summary()}`,
      tools.length
        ? isReAct
          ? "You have tools. YOU must call them yourself by outputting JSON. DO NOT tell the user to run commands. DO NOT say 'use a tool'. YOU are the one calling the tools."
          : "Use the provided tools to complete the task."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const ctx: ToolContext = {
      session_id: params.session_id,
      working_dir: params.working_dir,
      db: this.db,
      cfg: this.cfg,
    };

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...params.history.slice(-10),
      { role: "user", content: params.user_message },
    ];

    bus.emit({
      type: "agent_start",
      session_id: params.session_id,
      ts: new Date(),
      payload: { agent: this.agentName, model: activeModelAlias },
    });

    let lastFailedSig: string | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        this._end(params.session_id, "cancelled");
        return { reply: "", stopped_reason: "cancelled" };
      }

      if (turn === maxTurns - 1) {
        messages.push({
          role: "system",
          content: "FINAL TURN. Give your answer now. Do not call any more tools.",
        });
      }

      const useStructured = modelSupportsTools(activeModelCfg.model) && tools.length > 0;

      let response: ChatMessage;
      try {
        if (useStructured) {
          const res = await llm.chat({ messages, tools, tool_choice: "auto", signal });
          response = res.choices[0]?.message;
        } else {
          const res = await llm.chat({
            messages: [...messages, { role: "system", content: buildReActPrompt(tools) }],
            json_mode: true,
            signal,
          });
          response = await this.parseReAct(res.choices[0]?.message, messages, llm, signal);
        }
      } catch (e) {
        const msg = String(e);
        if (signal?.aborted || msg.includes("AbortError") || msg.includes("abort")) {
          this._end(params.session_id, "cancelled");
          return { reply: "", stopped_reason: "cancelled" };
        }

        const localCfg = this.cfg.models.local;
        const authFailure = /HTTP (401|403)/.test(msg) || msg.includes("authentication_error");
        const canFallback =
          authFailure &&
          !usedAuthFallback &&
          activeModelAlias !== "local" &&
          activeModelCfg.provider !== "ollama" &&
          Boolean(localCfg);

        if (canFallback && localCfg) {
          usedAuthFallback = true;
          activeModelAlias = "local";
          activeModelCfg = localCfg;
          llm = createLLMClient(localCfg);

          bus.emit({
            type: "agent_thought",
            session_id: params.session_id,
            ts: new Date(),
            payload: {
              agent: this.agentName,
              text: "Cloud provider auth failed, falling back to local model alias.",
            },
          });

          turn -= 1;
          continue;
        }

        log.error(`Agent ${this.agentName} LLM failed`, e);
        this._end(params.session_id, "error");
        if (/HTTP (401|403|404)/.test(msg)) throw new Error(msg); // fatal — let orchestrator abort
        return { reply: `Error: ${msg}`, stopped_reason: "error" };
      }

      // Strip <think> blocks from Qwen3 — surface as thought event, keep text clean
      let visibleContent = response.content;
      if (response.content && !response.tool_calls?.length) {
        const { text, thinking } = stripThinking(response.content);
        if (thinking) {
          bus.emit({
            type: "agent_thought",
            session_id: params.session_id,
            ts: new Date(),
            payload: { agent: this.agentName, text: `[thinking] ${thinking.slice(0, 200)}` },
          });
        }
        visibleContent = text || response.content;
      }

      messages.push({ role: "assistant", content: visibleContent, tool_calls: response.tool_calls });

      if (visibleContent && !response.tool_calls?.length) {
        bus.emit({
          type: "agent_thought",
          session_id: params.session_id,
          ts: new Date(),
          payload: { agent: this.agentName, text: visibleContent },
        });
      }

      if (!isToolCall(response)) {
        this._end(params.session_id, "done");
        return { reply: response.content ?? "", stopped_reason: "done" };
      }

      // Execute tool calls
      const toolResults: ChatMessage[] = [];
      for (const tc of response.tool_calls ?? []) {
        if (signal?.aborted) break;

        const sig = `${tc.function.name}:${tc.function.arguments}`;
        if (sig === lastFailedSig) {
          toolResults.push({
            role: "tool",
            content: `[blocked] ${tc.function.name} failed with same args — try different approach`,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
          lastFailedSig = null;
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          toolResults.push({
            role: "tool",
            content: `Bad JSON args for ${tc.function.name}`,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
          lastFailedSig = sig;
          continue;
        }

        bus.emit({
          type: "tool_start",
          session_id: params.session_id,
          ts: new Date(),
          payload: { tool: tc.function.name, agent: this.agentName },
        });

        const result = await this.registry.run({ id: tc.id, tool_name: tc.function.name, args }, ctx);

        bus.emit({
          type: "tool_end",
          session_id: params.session_id,
          ts: new Date(),
          payload: { tool: tc.function.name, duration_ms: result.duration_ms, error: result.error },
        });

        lastFailedSig = result.error ? sig : null;
        toolResults.push({
          role: "tool",
          content: result.result ?? result.error ?? "no output",
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }

      messages.push(...toolResults);
    }

    const lastContent = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    this._end(params.session_id, "max_turns");
    return { reply: lastContent, stopped_reason: "max_turns" };
  }

  private _end(sid: SessionId, reason: string) {
    bus.emit({
      type: "agent_end",
      session_id: sid,
      ts: new Date(),
      payload: { agent: this.agentName, stopped_reason: reason },
    });
  }

  /** Parse ReAct JSON — detects "use tool X" plain text and re-prompts */
  private async parseReAct(
    response: ChatMessage,
    messages: ChatMessage[],
    llm: ReturnType<typeof createLLMClient>,
    signal?: AbortSignal,
    depth = 0,
  ): Promise<ChatMessage> {
    const raw = response.content ?? "";
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Detect "use tool" / "you should run" / plain English advice — re-prompt once
    const isAdvice =
      depth === 0 &&
      (/\b(use|call|run|try|execute)\s+(the\s+)?(tool|run_shell|command)/i.test(raw) ||
        /you (should|need to|must|can)/i.test(raw) ||
        (!cleaned.startsWith("{") && cleaned.length > 0));

    if (isAdvice) {
      log.warn(`Agent output advice instead of JSON — re-prompting (depth ${depth}): ${raw.slice(0, 80)}`);
      try {
        const fix = await llm.chat({
          messages: [
            ...messages,
            { role: "assistant", content: raw },
            {
              role: "user",
              content: `Wrong format. You must output JSON, not instructions. Output the JSON tool call NOW:\n{"thought":"running command","tool":"run_shell","args":{"command":"uptime && cat /proc/loadavg"}}`,
            },
          ],
          json_mode: true,
          signal,
        });
        return this.parseReAct(fix.choices[0]?.message, messages, llm, signal, depth + 1);
      } catch {
        return { role: "assistant", content: raw };
      }
    }

    let parsed: { thought?: string; action?: string; tool?: string; result?: string; args?: Record<string, unknown> };
    try {
      parsed = JSON.parse(cleaned) as typeof parsed;
    } catch {
      if (depth >= 1) {
        log.warn("ReAct parse failed after recovery — using raw text");
        return { role: "assistant", content: raw };
      }
      try {
        const fix = await llm.chat({
          messages: [
            ...messages,
            { role: "assistant", content: raw },
            { role: "user", content: `Invalid JSON. Reply with ONLY valid JSON, no markdown:\n${raw.slice(0, 150)}` },
          ],
          json_mode: true,
          signal,
        });
        return this.parseReAct(fix.choices[0]?.message, messages, llm, signal, depth + 1);
      } catch {
        return { role: "assistant", content: raw };
      }
    }

    if (parsed.action === "final_answer" || !parsed.tool) {
      return { role: "assistant", content: parsed.result ?? parsed.thought ?? raw };
    }

    return {
      role: "assistant",
      content: parsed.thought ?? null,
      tool_calls: [
        {
          id: `react_${Date.now()}`,
          type: "function" as const,
          function: { name: parsed.tool, arguments: JSON.stringify(parsed.args ?? {}) },
        },
      ],
    };
  }
}

function buildReActPrompt(tools: OAITool[]): string {
  const list = tools.map((t) => `- ${t.function.name}: ${t.function.description}`).join("\n");
  return `You MUST output ONLY a single JSON object. No text before or after. No markdown.

Available tools:
${list}

To call a tool, output exactly this shape:
{"thought":"I need to run uptime to check load","tool":"run_shell","args":{"command":"uptime"}}

When you have the final answer, output exactly this shape:
{"thought":"I have the results","action":"final_answer","result":"the actual answer text here"}

RULES:
- Output ONLY JSON. Nothing else.
- Do NOT say "use run_shell" or "you should run". YOU run it by outputting the JSON above.
- The "tool" field must be an exact tool name from the list above.
- Never output plain English sentences as your response.`;
}

// ── Orchestrator ──────────────────────────────────────────────

export interface OrchestratorParams {
  session_id: SessionId;
  blackboard: Blackboard;
  user_message: string;
  history: ChatMessage[];
  working_dir: string;
  mode: string;
  signal?: AbortSignal;
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

    const orchAlias = runtimeCfg.orchestrator.model;
    const orchCfg = runtimeCfg.models[orchAlias];
    if (!orchCfg) throw new Error(`Orchestrator model alias not found: ${orchAlias}`);

    const pendingHandled = await this.handlePendingSkillProposal(blackboard, user_message);
    if (pendingHandled) {
      return {
        reply: pendingHandled,
        blackboard,
        stopped_reason: "done",
      };
    }

    const proposalReply = await this.maybeProposeSkillAcquisition(
      runtimeCfg,
      orchCfg,
      blackboard,
      user_message,
      signal,
    );
    if (proposalReply) {
      return {
        reply: proposalReply,
        blackboard,
        stopped_reason: "done",
      };
    }

    const workflowTrack = detectWorkflowTrack(user_message);
    if (workflowTrack !== "standard") {
      return this.runWorkflowTrack(workflowTrack, runtimeCfg, params);
    }

    blackboard.appendDecision(0, "start", "orchestrator", user_message.slice(0, 80));

    // ── Step 1: orchestrator picks one configured agent ─────────────────────
    let decision: { action: string; target?: string; reason?: string };
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
        log.warn("Orchestrator non-JSON — defaulting to first configured agent", { raw: raw.slice(0, 80) });
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
      log.warn(`Agent "${preferredTarget}" not defined — falling back to "${targetName}"`);
    }

    // ── Step 2: run the chosen agent ──────────────────────────
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

    // If orchestrator routed to responder directly, we're done
    if (targetName === "responder" || !agentResult.reply) {
      return { reply: agentResult.reply, blackboard, stopped_reason: agentResult.stopped_reason };
    }

    // ── Step 3: responder synthesises — no orchestrator re-eval ──
    // This is the key fix: we NEVER give the orchestrator a second turn.
    // After engineer/analyst succeeds, responder always runs next.
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
        return `Created skill \"${created.spec.name}\" with tool \"${created.spec.tool_name}\" at ${created.path}. It is now registered and available for this session.`;
      } catch (error) {
        blackboard.setScratchpad(PENDING_SKILL_KEY, null);
        return `Skill creation failed: ${String(error)}`;
      }
    }

    if (isNegative(userMessage)) {
      blackboard.setScratchpad(PENDING_SKILL_KEY, null);
      return "Understood. I cancelled that proposed skill acquisition.";
    }

    return `Pending skill proposal: \"${pending.name}\" (${pending.description}). Reply with 'yes' to create it or 'no' to cancel.`;
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
        `I detected a reusable capability gap and propose a new skill: \"${proposal.name}\".`,
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
          {
            role: "system",
            content: buildSkillAcquisitionPrompt(userMessage, toolNames),
          },
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
        `I detected a reusable capability gap and propose a new skill: \"${proposal.name}\".`,
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

  private workflowPlan(track: WorkflowTrack, cfg: Config): string[] {
    const productPlan = ["planner", "prd_designer", "delivery_manager", "engineer", "responder"];
    const opsPlan = ["planner", "operations_commander", "analyst", "engineer", "responder"];
    const preferred = track === "product_delivery" ? productPlan : opsPlan;
    const plan = preferred.filter((name) => Boolean(cfg.agents[name]));
    if (plan.length) return plan;

    const fallback = ["analyst", "engineer", "responder"].filter((name) => Boolean(cfg.agents[name]));
    return fallback.length ? fallback : Object.keys(cfg.agents).slice(0, 1);
  }

  private async runWorkflowTrack(
    track: WorkflowTrack,
    runtimeCfg: Config,
    params: OrchestratorParams,
  ): Promise<AgentRunResult> {
    const { session_id, blackboard, user_message, history, working_dir, signal } = params;
    const plan = this.workflowPlan(track, runtimeCfg);
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
      ]) {
        if (has("smart") && clone.agents[name]) clone.agents[name].model = "smart";
      }
      if (has("fast") && clone.agents.responder) clone.agents.responder.model = "fast";
      return clone;
    }

    return this.cfg;
  }
}
