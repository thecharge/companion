import type { Config } from "@companion/config";
import type { DB, SessionId } from "@companion/db";
import type { OAITool } from "@companion/llm";

export interface ToolContext {
  session_id: SessionId;
  working_dir: string;
  db: DB;
  cfg: Config;
}

export interface ToolCall {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  tool_name: string;
  result?: string;
  error?: string;
  duration_ms: number;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export interface ToolDefinition {
  schema: OAITool;
  handler: ToolHandler;
}
