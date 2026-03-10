/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { ModelConfig } from "@companion/config";
import { LLMClientFacade } from "./core/facade";
import { createProviderStrategy } from "./core/strategy-factory";

export type {
  ChatChoice,
  ChatMessage,
  ChatParams,
  ChatResponse,
  LLMProviderStrategy,
  OAITool,
  OAIToolCall,
  UsageStats,
} from "./core/public-types";

export { firstChoice, isOllama, isToolCall, modelSupportsTools, stripThinking } from "./core/helpers";

export class LLMClient extends LLMClientFacade {
  constructor(cfg: ModelConfig) {
    super(cfg, createProviderStrategy(cfg));
  }
}

export function createLLMClient(cfg: ModelConfig): LLMClient {
  return new LLMClient(cfg);
}
