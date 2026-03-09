/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { ToolDefinition } from "./types";

const MASKED = "***";

export function createRuntimePostureTool(): ToolDefinition {
  return {
    schema: {
      type: "function",
      function: {
        name: "runtime_posture",
        description: "Return production posture summary for sandbox, auth, and default mode.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    handler: async (_args, ctx) => {
      const isDevSecret = !ctx.cfg.server.secret || ctx.cfg.server.secret === "dev-secret";
      const posture = {
        mode_default: ctx.cfg.mode.default,
        sandbox_runtime: ctx.cfg.sandbox.runtime,
        sandbox_allow_direct_fallback: ctx.cfg.sandbox.allow_direct_fallback,
        server_secret_set: !isDevSecret,
      };
      return JSON.stringify(posture, null, 2);
    },
  };
}

export function createProviderMatrixTool(): ToolDefinition {
  return {
    schema: {
      type: "function",
      function: {
        name: "provider_matrix",
        description: "List configured model aliases and providers with auth readiness flags.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    handler: async (_args, ctx) => {
      const models = Object.entries(ctx.cfg.models).map(([alias, model]) => ({
        alias,
        provider: model.provider,
        model: model.model,
        base_url: model.base_url ?? null,
        api_key_present: Boolean(model.api_key),
        api_key_value: model.api_key ? MASKED : null,
      }));

      return JSON.stringify({ models }, null, 2);
    },
  };
}
