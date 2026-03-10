import type { Config } from "@companion/config";
import type { DB } from "@companion/db";
import {
  createListDirTool,
  createReadFileTool,
  createRepoMapTool,
  createSearchCodeTool,
  createSearchHistoryTool,
  createWriteFileTool,
} from "../core-tools";
import { createMcpServersTool, createProviderMatrixTool, createRuntimePostureTool } from "../ops-tools";
import { SandboxExecutor, createRunShellTool, createRunTestsTool } from "../sandbox";
import type { ToolDefinition } from "../types";
import { createWeatherLookupTool, createWebFetchTool } from "../web-tools";

export interface ToolFactoryResult {
  tools: ToolDefinition[];
  sandbox: SandboxExecutor;
}

export const createDefaultTools = (cfg: Config, _db: DB): ToolFactoryResult => {
  const sandbox = new SandboxExecutor(cfg);
  const tools: ToolDefinition[] = [
    createReadFileTool(),
    createWriteFileTool(),
    createListDirTool(),
    createSearchCodeTool(),
    createRepoMapTool(),
    createSearchHistoryTool(),
    createRunShellTool(sandbox),
    createWebFetchTool(),
    createWeatherLookupTool(),
    createRunTestsTool(sandbox),
    createRuntimePostureTool(),
    createProviderMatrixTool(),
    createMcpServersTool(),
  ];

  return { tools, sandbox };
};
