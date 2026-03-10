/**
 * @companion/tools
 *
 * Composition entrypoint for tool types, registry, sandbox, and built-in tools.
 */

import type { Config } from "@companion/config";
import type { DB } from "@companion/db";
import { createDefaultTools } from "./factories/default-tools-factory";
import { ToolRegistry } from "./registry";
import { SandboxExecutor } from "./sandbox";
import type { ToolCall, ToolContext, ToolDefinition, ToolHandler, ToolResult } from "./types";

export type { ToolCall, ToolContext, ToolDefinition, ToolHandler, ToolResult };
export { ToolRegistry, SandboxExecutor };

export function createToolRegistry(cfg: Config, _db: DB): { registry: ToolRegistry; sandbox: SandboxExecutor } {
  const { tools, sandbox } = createDefaultTools(cfg, _db);
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }

  return { registry, sandbox };
}
