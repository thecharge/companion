/**
 * @companion/tools
 *
 * Composition entrypoint for tool types, registry, sandbox, and built-in tools.
 */

import type { Config } from "@companion/config";
import type { DB } from "@companion/db";
import { createListDirTool, createReadFileTool, createSearchHistoryTool, createWriteFileTool } from "./core-tools";
import { createProviderMatrixTool, createRuntimePostureTool } from "./ops-tools";
import { ToolRegistry } from "./registry";
import { SandboxExecutor, createRunShellTool, createRunTestsTool } from "./sandbox";
import type { ToolCall, ToolContext, ToolDefinition, ToolHandler, ToolResult } from "./types";
import { createWeatherLookupTool, createWebFetchTool } from "./web-tools";

export type { ToolCall, ToolContext, ToolDefinition, ToolHandler, ToolResult };
export { ToolRegistry, SandboxExecutor };

export function createToolRegistry(cfg: Config, _db: DB): { registry: ToolRegistry; sandbox: SandboxExecutor } {
  const sandbox = new SandboxExecutor(cfg);
  const registry = new ToolRegistry();

  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  registry.register(createListDirTool());
  registry.register(createSearchHistoryTool());
  registry.register(createRunShellTool(sandbox));
  registry.register(createWebFetchTool());
  registry.register(createWeatherLookupTool());
  registry.register(createRunTestsTool(sandbox));
  registry.register(createRuntimePostureTool());
  registry.register(createProviderMatrixTool());

  return { registry, sandbox };
}
