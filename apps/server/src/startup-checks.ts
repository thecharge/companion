/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { Config } from "@companion/config";
import { Logger, type SessionId } from "@companion/core";
import type { SandboxExecutor } from "@companion/tools";

const log = new Logger("server.startup");

function modelPrefix(model: string): string {
  return model.split(":")[0] ?? model;
}

export async function runStartupChecks(params: {
  cfg: Config;
  sandbox: SandboxExecutor;
  embedBase: string;
  embedModelName: string;
}): Promise<void> {
  const { cfg, sandbox, embedBase, embedModelName } = params;
  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    if (!cfg.server.secret || cfg.server.secret === "dev-secret") {
      log.warn("Production warning: server.secret is unset or using dev default.");
    }
    if (cfg.sandbox.allow_direct_fallback) {
      log.warn("Production warning: sandbox.allow_direct_fallback=true reduces isolation guarantees.");
    }
    if (cfg.sandbox.runtime === "auto" || cfg.sandbox.runtime === "direct") {
      log.warn(`Production warning: sandbox.runtime is "${cfg.sandbox.runtime}". Pin to "docker" or "podman".`);
    }

    if (cfg.integrations.slack.enabled) {
      const slackTrust = cfg.integrations.slack;
      const hasSlackTrustList =
        slackTrust.trusted_user_ids.length > 0 ||
        slackTrust.trusted_channel_ids.length > 0 ||
        slackTrust.trusted_team_ids.length > 0;
      if (!hasSlackTrustList) {
        log.warn("Production warning: Slack integration enabled without trusted allowlists.");
      }
      if (!slackTrust.required_passphrase) {
        log.warn("Production warning: Slack integration has no required_passphrase step-up gate.");
      }
    }

    if (cfg.integrations.telegram.enabled) {
      const telegramTrust = cfg.integrations.telegram;
      const hasTelegramTrustList =
        telegramTrust.trusted_user_ids.length > 0 || telegramTrust.trusted_chat_ids.length > 0;
      if (!hasTelegramTrustList) {
        log.warn("Production warning: Telegram integration enabled without trusted allowlists.");
      }
      if (!telegramTrust.required_passphrase) {
        log.warn("Production warning: Telegram integration has no required_passphrase step-up gate.");
      }
    }
  }

  const sandboxStrategy = await sandbox.probe();
  await sandbox.cleanupZombies().catch((e) => log.warn("Zombie cleanup error", e));

  if (sandboxStrategy.kind === "container") {
    log.info(`Sandbox: ${sandbox.describe()}`);
  } else if (sandboxStrategy.kind === "direct") {
    log.warn(`Sandbox warning: ${sandboxStrategy.warning}`);
  } else {
    log.warn(`Sandbox refused: ${sandboxStrategy.reason}`);
  }

  try {
    const embedCheckRes = await fetch(`${embedBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (embedCheckRes.ok) {
      const tags = (await embedCheckRes.json()) as { models?: Array<{ name: string }> };
      const available = tags.models?.map((x) => x.name) ?? [];
      const embedPresent = available.some((name) => name.startsWith(modelPrefix(embedModelName)));
      if (embedPresent) {
        log.info(`Embed model \"${embedModelName}\" ready`);
      } else {
        log.warn(`Embed model \"${embedModelName}\" not found. Run: ollama pull ${embedModelName}`);
        log.warn("Semantic recall is disabled until the embedding model is available.");
      }
    }
  } catch {
    log.warn(`Cannot check embed model \"${embedModelName}\" - Ollama not reachable`);
  }

  const ollamaModels = Object.entries(cfg.models).filter(([, model]) => model.provider === "ollama");
  for (const [alias, model] of ollamaModels) {
    const base = (model.base_url ?? "http://localhost:11434").replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const available = data.models?.map((x) => x.name) ?? [];
      const present = available.some((name) => name.startsWith(modelPrefix(model.model)));

      if (present) {
        log.info(`Ollama model \"${model.model}\" (alias: ${alias}) ready`);
      } else {
        log.warn(`Ollama model \"${model.model}\" missing. Run: ollama pull ${model.model}`);
      }
    } catch {
      log.warn(`Ollama not reachable at ${base} for alias \"${alias}\"`);
    }
  }
}

export interface ActiveTaskState {
  agent: string;
  tool?: string;
  thought?: string;
  status: "thinking" | "running_tool" | "synthesizing";
}

export type ActiveTaskMap = Map<SessionId, ActiveTaskState>;
