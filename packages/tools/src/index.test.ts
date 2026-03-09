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

  test("can register common repo navigation tools", () => {
    const registry = new ToolRegistry();
    for (const name of ["repo_map", "search_code"]) {
      registry.register({
        schema: {
          type: "function",
          function: {
            name,
            description: `${name} description`,
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
        handler: async () => "ok",
      });
    }

    expect(registry.get("repo_map")?.schema.function.name).toBe("repo_map");
    expect(registry.get("search_code")?.schema.function.name).toBe("search_code");
  });
});
