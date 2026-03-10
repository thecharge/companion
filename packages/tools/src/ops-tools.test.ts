/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { createMcpServersTool, createProviderMatrixTool, createRuntimePostureTool } from "./ops-tools";

const mockContext = {
  cfg: {
    server: { secret: "dev-secret" },
    mode: { default: "balanced" },
    sandbox: { runtime: "auto", allow_direct_fallback: true },
    mcp: {
      enabled: true,
      servers: {
        github: {
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {},
          timeout_seconds: 30,
        },
      },
    },
    models: {
      local: { provider: "ollama", model: "qwen3:1.7b", base_url: "http://localhost:11434" },
      smart: { provider: "anthropic", model: "claude", api_key: "test-key" },
    },
  },
} as unknown as import("./types").ToolContext;

describe("ops tools", () => {
  test("runtime posture tool reports hardening flags", async () => {
    const tool = createRuntimePostureTool();
    const result = await tool.handler({}, mockContext);
    expect(result).toContain("mode_default");
    expect(result).toContain("sandbox_allow_direct_fallback");
  });

  test("provider matrix tool lists configured aliases", async () => {
    const tool = createProviderMatrixTool();
    const result = await tool.handler({}, mockContext);
    expect(result).toContain("local");
    expect(result).toContain("smart");
    expect(result).toContain("api_key_present");
  });

  test("mcp servers tool reports configured MCP servers", async () => {
    const tool = createMcpServersTool();
    const result = await tool.handler({}, mockContext);
    expect(result).toContain("mcp_enabled");
    expect(result).toContain("github");
  });
});
