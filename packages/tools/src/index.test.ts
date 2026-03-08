/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "./index";

describe("tool registry", () => {
  test("registers and resolves tools", () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: {
        type: "function",
        function: {
          name: "ping_tool",
          description: "ping",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      handler: async () => "pong",
    });

    const tool = registry.get("ping_tool");
    expect(tool?.schema.function.name).toBe("ping_tool");
    expect(registry.list().length).toBe(1);
  });
});
