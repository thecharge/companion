/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { Config } from "@companion/config";

const PROVIDERS_REQUIRING_API_KEY = new Set(["anthropic", "openai", "gemini"]);

export const selectSummaryModel = (cfg: Config) => {
  const alias = cfg.memory.summarisation.model;
  const preferred = cfg.models[alias];
  if (!preferred) return undefined;

  const requiresApiKey = PROVIDERS_REQUIRING_API_KEY.has(preferred.provider) && !preferred.api_key;
  if (requiresApiKey) {
    return cfg.models.local;
  }

  return preferred;
};
