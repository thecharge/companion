import type { OAITool } from "@companion/llm";
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from "./types";

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(def: ToolDefinition): void {
    this.tools.set(def.schema.function.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): OAITool[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const def = this.tools.get(call.tool_name);

    if (!def) {
      return {
        tool_call_id: call.id,
        tool_name: call.tool_name,
        error: `Unknown tool: ${call.tool_name}`,
        duration_ms: Date.now() - start,
      };
    }

    try {
      const result = await def.handler(call.args, ctx);
      return { tool_call_id: call.id, tool_name: call.tool_name, result, duration_ms: Date.now() - start };
    } catch (e) {
      return {
        tool_call_id: call.id,
        tool_name: call.tool_name,
        error: String(e),
        duration_ms: Date.now() - start,
      };
    }
  }
}
