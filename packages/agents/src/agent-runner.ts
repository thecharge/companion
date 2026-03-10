import type { Config } from "@companion/config";
import { Logger, type SessionId, bus } from "@companion/core";
import type { DB } from "@companion/db";
import type { ChatMessage, OAITool } from "@companion/llm";
import { createLLMClient, isToolCall, modelSupportsTools, stripThinking } from "@companion/llm";
import type { MemoryService } from "@companion/memory";
import type { ToolContext, ToolRegistry } from "@companion/tools";
import { buildReActPrompt } from "./prompts";
import { parseReActMessage } from "./react-parser";
import type { AgentRunParams } from "./types";

const log = new Logger("agents");

const asksForLiveSystemLoad = (message: string): boolean => {
  return /\b(system\s+load|cpu\s+load|load\s+average|uptime|memory\s+usage|disk\s+usage|current\s+load|host\s+load)\b/i.test(
    message,
  );
};

const looksLikeFileMutationClaim = (text: string): boolean => {
  return /(created|wrote|saved|updated|edited|renamed|deleted|moved)\b[\s\S]{0,80}\b(file|folder|directory|script)\b/i.test(
    text,
  );
};

export class AgentRunner {
  constructor(
    private agentName: string,
    private cfg: Config,
    private registry: ToolRegistry,
    private _memory: MemoryService,
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
    const loadCheck = asksForLiveSystemLoad(params.user_message);
    const hasShellTool = agentCfg.tools.includes("run_shell");
    const systemPrompt = [
      `You are the ${this.agentName} agent. ${agentCfg.description}`,
      `Goal: ${params.blackboard.goal || params.user_message}`,
      `Context:\n${params.blackboard.summary()}`,
      loadCheck && hasShellTool
        ? "For system-load questions, you MUST call run_shell to obtain live values before answering. Do not estimate or fabricate numbers."
        : "",
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
    let successfulToolCalls = 0;

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
          response = await parseReActMessage(res.choices[0]?.message, messages, llm, signal);
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
        if (/HTTP (401|403|404)/.test(msg)) throw new Error(msg);
        return { reply: `Error: ${msg}`, stopped_reason: "error" };
      }

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
        const plainReply = response.content ?? "";
        if (successfulToolCalls === 0 && looksLikeFileMutationClaim(plainReply)) {
          const guardedReply =
            "I did not execute file tools successfully in this run, so no file changes were applied. " +
            "I can run the required tool operations and then verify the resulting paths explicitly.";
          bus.emit({
            type: "agent_thought",
            session_id: params.session_id,
            ts: new Date(),
            payload: { agent: this.agentName, text: guardedReply },
          });
          this._end(params.session_id, "done");
          return { reply: guardedReply, stopped_reason: "done" };
        }
        this._end(params.session_id, "done");
        return { reply: plainReply, stopped_reason: "done" };
      }

      const toolResults: ChatMessage[] = [];
      for (const tc of response.tool_calls ?? []) {
        if (signal?.aborted) break;

        const sig = `${tc.function.name}:${tc.function.arguments}`;
        if (sig === lastFailedSig) {
          toolResults.push({
            role: "tool",
            content: `[blocked] ${tc.function.name} failed with same args - try different approach`,
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
        if (!result.error) {
          successfulToolCalls += 1;
        }
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
}
