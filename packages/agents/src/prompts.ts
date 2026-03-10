import type { Config } from "@companion/config";
import type { Blackboard } from "@companion/core";
import type { OAITool } from "@companion/llm";
import type { ToolRegistry } from "@companion/tools";

export function buildOrchestratorPrompt(cfg: Config, registry: ToolRegistry, bb: Blackboard, mode: string): string {
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

export function buildReActPrompt(tools: OAITool[]): string {
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
- Never output plain English sentences as your response.

RULES FOR FILE/FOLDER TASKS:
- If the user asks to create, edit, rename, delete, or move files/folders/scripts, you MUST call file/shell tools to perform it.
- Never claim a file/folder was created or changed unless a tool call in this run succeeded.
- Prefer paths under the current working directory. If the user asks for host /tmp or another external path, explain sandbox/isolation limits and use a workspace path instead.
- If required tools are unavailable, return final_answer that clearly says the action was NOT executed.`;
}
