/**
 * @companion/agents
 *
 * Orchestrator: reads Blackboard, dispatches to agents, verifies results.
 * AgentRunner:  ReAct loop (structured tool calls for capable models,
 *               JSON mode for small Ollama models).
 *
 * Key design decisions:
 * - Orchestrator is a DISPATCHER only — never does the work itself
 * - Asymmetric verify: skip if worker model outranks orchestrator
 * - Duplicate error circuit breaker: prevents infinite retry loops
 * - max_turns graceful exit: injects WARNING on penultimate turn
 * - agent_thought events: TUI shows live reasoning
 */

import type { Config } from "@companion/config";
import {
  Blackboard,
  Logger,
  bus,
  type SessionId,
} from "@companion/core";
import type { DB } from "@companion/db";
import { createLLMClient, isToolCall, modelSupportsTools, type ChatMessage, type OAITool } from "@companion/llm";
import type { MemoryService } from "@companion/memory";
import type { ToolRegistry, ToolContext } from "@companion/tools";

const log = new Logger("agents");

// ── Types ─────────────────────────────────────────────────────

export interface AgentRunParams {
  session_id:   SessionId;
  blackboard:   Blackboard;
  user_message: string;
  history:      ChatMessage[];
  working_dir:  string;
}

export interface AgentRunResult {
  reply:          string;
  blackboard:     Blackboard;
  stopped_reason: "done" | "max_turns" | "error";
}

// ── Orchestrator prompt ───────────────────────────────────────

function buildOrchestratorPrompt(bb: Blackboard, mode: string): string {
  return `You are an orchestrator. Your ONLY job is to decide which agent to call next.
DO NOT do the work yourself. DO NOT call write_file, read_file, or any task tool directly.
If the user wants code written, route to 'engineer'. If analysis is needed, route to 'analyst'.
Use 'reply' or 'done' only after agents have produced the answer.

Mode: ${mode}
${bb.summary()}

Respond with ONLY valid JSON in this exact shape:
{"action":"run_agent","target":"engineer","reason":"needs code written"}
{"action":"run_agent","target":"analyst","reason":"needs data analysis"}
{"action":"reply","target":"responder","reason":"ready to synthesise"}
{"action":"done","reason":"task complete, already replied"}`;
}

// ── Blackboard → Markdown (small models parse this better than JSON) ──

function formatBlackboard(bb: Blackboard): string {
  return bb.summary();
}

// ── AgentRunner ───────────────────────────────────────────────

class AgentRunner {
  constructor(
    private agentName: string,
    private cfg:       Config,
    private registry:  ToolRegistry,
    private memory:    MemoryService,
    private db:        DB,
  ) {}

  async run(params: AgentRunParams): Promise<{ reply: string; stopped_reason: "done" | "max_turns" | "error" }> {
    const agentCfg    = this.cfg.agents[this.agentName];
    if (!agentCfg) throw new Error(`Unknown agent: ${this.agentName}`);

    const modelAlias  = agentCfg.model;
    const modelCfg    = this.cfg.models[modelAlias];
    if (!modelCfg) throw new Error(`Unknown model alias: ${modelAlias}`);

    const llm         = createLLMClient(modelCfg);
    const maxTurns    = agentCfg.max_turns;
    const tools       = agentCfg.tools
      .map((name) => this.registry.get(name)?.schema)
      .filter((t): t is OAITool => t !== undefined);

    const bbView      = formatBlackboard(params.blackboard);
    const systemPrompt = [
      `You are the ${this.agentName} agent. ${agentCfg.description}`,
      `Blackboard:\n${bbView}`,
      tools.length ? "Use the provided tools to complete the task." : "",
    ].filter(Boolean).join("\n\n");

    const ctx: ToolContext = {
      session_id:  params.session_id,
      working_dir: params.working_dir,
      db:          this.db,
      cfg:         this.cfg,
    };

    const messages: ChatMessage[] = [
      { role: "system",  content: systemPrompt },
      ...params.history.slice(-20),
      { role: "user", content: params.user_message },
    ];

    bus.emit({ type: "agent_start", session_id: params.session_id, ts: new Date(),
      payload: { agent: this.agentName, model: modelAlias } });

    let lastFailedSignature: string | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      // Penultimate turn — force final synthesis
      if (turn === maxTurns - 1) {
        messages.push({
          role:    "system",
          content: "WARNING: This is your last turn. Synthesise everything and give a final answer now. Do not call any more tools.",
        });
      }

      const useStructured = modelSupportsTools(modelCfg.model) && tools.length > 0;

      let response: ChatMessage;
      try {
        if (useStructured) {
          const res = await llm.chat({ messages, tools, tool_choice: "auto" });
          response  = res.choices[0]!.message;
        } else {
          // Small Ollama model — JSON mode ReAct
          const reactPrompt = buildReActPrompt(tools);
          const res = await llm.chat({
            messages: [...messages, { role: "system", content: reactPrompt }],
            json_mode: true,
          });
          response = res.choices[0]!.message;
          response = await this.parseReActResponse(response, messages, llm, tools);
        }
      } catch (e) {
        log.error(`Agent ${this.agentName} LLM call failed`, e);
        bus.emit({ type: "agent_end", session_id: params.session_id, ts: new Date(),
          payload: { agent: this.agentName, stopped_reason: "error" } });
        return { reply: `Agent error: ${String(e)}`, stopped_reason: "error" };
      }

      messages.push({ role: "assistant", content: response.content, tool_calls: response.tool_calls });

      // Emit thought if text content present alongside tool calls
      if (response.content) {
        bus.emit({ type: "agent_thought", session_id: params.session_id, ts: new Date(),
          payload: { agent: this.agentName, text: response.content } });
      }

      // Done — no more tool calls
      if (!isToolCall(response)) {
        bus.emit({ type: "agent_end", session_id: params.session_id, ts: new Date(),
          payload: { agent: this.agentName, stopped_reason: "done" } });
        return { reply: response.content ?? "", stopped_reason: "done" };
      }

      // Execute tool calls
      const toolResults: ChatMessage[] = [];
      for (const tc of response.tool_calls ?? []) {
        const callSig = `${tc.function.name}:${tc.function.arguments}`;

        // Circuit breaker — same call failing twice means model is stuck
        if (callSig === lastFailedSignature) {
          const breakMsg = `[circuit breaker] Tool ${tc.function.name} failed with identical args. Try a different approach.`;
          messages.push({ role: "tool", content: breakMsg, tool_call_id: tc.id, name: tc.function.name });
          lastFailedSignature = null;
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          const errMsg = `Invalid arguments JSON for ${tc.function.name}: ${tc.function.arguments.slice(0, 100)}`;
          toolResults.push({ role: "tool", content: errMsg, tool_call_id: tc.id, name: tc.function.name });
          lastFailedSignature = callSig;
          continue;
        }

        bus.emit({ type: "tool_start", session_id: params.session_id, ts: new Date(),
          payload: { tool: tc.function.name, agent: this.agentName } });

        const result = await this.registry.run({ id: tc.id, tool_name: tc.function.name, args }, ctx);

        bus.emit({ type: "tool_end", session_id: params.session_id, ts: new Date(),
          payload: { tool: tc.function.name, duration_ms: result.duration_ms, error: result.error } });

        if (result.error) {
          lastFailedSignature = callSig;
        } else {
          lastFailedSignature = null;
        }

        toolResults.push({
          role:         "tool",
          content:      result.result ?? result.error ?? "no output",
          tool_call_id: tc.id,
          name:         tc.function.name,
        });
      }

      messages.push(...toolResults);
    }

    // Exhausted turns
    const lastContent = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    bus.emit({ type: "agent_end", session_id: params.session_id, ts: new Date(),
      payload: { agent: this.agentName, stopped_reason: "max_turns" } });
    return { reply: lastContent, stopped_reason: "max_turns" };
  }

  private async parseReActResponse(
    response:  ChatMessage,
    messages:  ChatMessage[],
    llm:       ReturnType<typeof createLLMClient>,
    tools:     OAITool[],
  ): Promise<ChatMessage> {
    const raw = response.content ?? "";
    try {
      const parsed = JSON.parse(raw) as { thought?: string; action?: string; tool?: string; args?: Record<string, unknown> };
      if (parsed.action === "final_answer" || !parsed.tool) {
        return { role: "assistant", content: parsed.thought ?? raw };
      }
      // Reconstruct as tool_calls
      return {
        role:    "assistant",
        content: parsed.thought ?? null,
        tool_calls: [{
          id:   `react_${Date.now()}`,
          type: "function" as const,
          function: {
            name:      parsed.tool ?? "unknown",
            arguments: JSON.stringify(parsed.args ?? {}),
          },
        }],
      };
    } catch {
      // Recovery: ask model to fix its output
      const recovery = await llm.chat({
        messages: [
          ...messages,
          { role: "assistant", content: raw },
          {
            role:    "user",
            content: `Your output was not valid JSON. Output ONLY valid JSON starting with { and ending with }. No apologies, no explanation.\nBroken: ${raw.slice(0, 200)}`,
          },
        ],
        json_mode: true,
      });
      const fixed = recovery.choices[0]?.message ?? { role: "assistant" as const, content: raw };
      return this.parseReActResponse(fixed, messages, llm, tools);
    }
  }
}

function buildReActPrompt(tools: OAITool[]): string {
  const toolList = tools.map((t) => `- ${t.function.name}: ${t.function.description}`).join("\n");
  return `You must respond with ONLY valid JSON. No markdown, no explanation.
Available tools:\n${toolList}

To call a tool: {"thought":"why","tool":"tool_name","args":{"param":"value"}}
When done:      {"thought":"reasoning","action":"final_answer","result":"your answer"}`;
}

// ── Orchestrator ──────────────────────────────────────────────

export interface OrchestratorParams {
  session_id:   SessionId;
  blackboard:   Blackboard;
  user_message: string;
  history:      ChatMessage[];
  working_dir:  string;
  mode:         string;
}

export class SessionProcessor {
  constructor(
    private cfg:      Config,
    private registry: ToolRegistry,
    private memory:   MemoryService,
    private db:       DB,
  ) {}

  async handleMessage(params: OrchestratorParams): Promise<AgentRunResult> {
    const { session_id, blackboard, user_message, history, working_dir, mode } = params;

    const orchAlias = this.cfg.orchestrator.model;
    const orchCfg   = this.cfg.models[orchAlias];
    if (!orchCfg) throw new Error(`Orchestrator model alias not found: ${orchAlias}`);

    const orchLLM   = createLLMClient(orchCfg);
    const maxRounds = this.cfg.orchestrator.max_rounds;

    blackboard.appendDecision(0, "start", "orchestrator", `User: ${user_message.slice(0, 100)}`);

    for (let round = 1; round <= maxRounds; round++) {
      const prompt  = buildOrchestratorPrompt(blackboard, mode);
      const orchRes = await orchLLM.chat({
        messages: [
          { role: "system", content: prompt },
          { role: "user",   content: user_message },
        ],
        json_mode: orchCfg.provider === "ollama",
      });

      const raw = orchRes.choices[0]?.message.content ?? "";

      let decision: { action: string; target?: string; reason?: string };
      try {
        decision = JSON.parse(raw) as typeof decision;
      } catch {
        log.warn("Orchestrator returned non-JSON, defaulting to responder", { raw: raw.slice(0, 100) });
        decision = { action: "reply", target: "responder", reason: "orchestrator parse error" };
      }

      bus.emit({ type: "orchestrator_decision", session_id, ts: new Date(),
        payload: { round, action: decision.action, target: decision.target } });

      blackboard.appendDecision(round, decision.action, decision.target ?? "", decision.reason ?? "");

      if (decision.action === "done") {
        const lastObs = blackboard.read("observations").slice(-1)[0] ?? "";
        return { reply: lastObs, blackboard, stopped_reason: "done" };
      }

      if (decision.action === "reply" || decision.action === "run_agent") {
        const targetName = decision.target ?? "responder";
        const agentDef   = this.cfg.agents[targetName];

        if (!agentDef) {
          blackboard.appendRejection(round, targetName, `Agent "${targetName}" not found`);
          continue;
        }

        const runner = new AgentRunner(targetName, this.cfg, this.registry, this.memory, this.db);
        const result = await runner.run({ session_id, blackboard, user_message, history, working_dir });

        // Asymmetric verify: skip if agent model outranks orchestrator
        const agentModelAlias = agentDef.model;
        const shouldVerify    = this.cfg.orchestrator.verify_results &&
          !(orchCfg.provider === "ollama" && this.cfg.models[agentModelAlias]?.provider !== "ollama");

        if (shouldVerify && result.reply) {
          const verdict = await this.verify(orchLLM, user_message, result.reply);
          bus.emit({ type: "orchestrator_verify", session_id, ts: new Date(), payload: verdict });

          if (!verdict.ok) {
            blackboard.appendRejection(round, targetName, verdict.reason);
            continue;
          }
        } else if (!shouldVerify) {
          log.info(`Skipping verify: agent "${agentModelAlias}" outranks orchestrator "${orchAlias}"`);
        }

        blackboard.appendObservation(`[${targetName}] ${result.reply.slice(0, 400)}`);

        if (decision.action === "reply" || targetName === "responder") {
          return { reply: result.reply, blackboard, stopped_reason: result.stopped_reason };
        }
      }
    }

    // Max rounds exhausted — synthesise what we have
    const lastObs = blackboard.read("observations").slice(-1)[0] ?? "Unable to complete task within round limit.";
    return { reply: lastObs, blackboard, stopped_reason: "max_turns" };
  }

  private async verify(
    llm:         ReturnType<typeof createLLMClient>,
    userMessage: string,
    agentReply:  string,
  ): Promise<{ ok: boolean; reason: string }> {
    const res = await llm.chat({
      messages: [
        {
          role:    "system",
          content: `You verify agent outputs. Reply ONLY with valid JSON: {"ok":true,"reason":"..."} or {"ok":false,"reason":"..."}`,
        },
        {
          role:    "user",
          content: `Task: ${userMessage}\nAgent reply: ${agentReply.slice(0, 600)}\nIs the reply correct and complete?`,
        },
      ],
      json_mode: true,
    });
    try {
      return JSON.parse(res.choices[0]?.message.content ?? "{}") as { ok: boolean; reason: string };
    } catch {
      return { ok: true, reason: "verify parse error — assuming ok" };
    }
  }
}
