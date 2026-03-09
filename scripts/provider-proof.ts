/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

type ProbeStatus = "pass" | "fail" | "skip";

interface ProbeResult {
  alias: string;
  provider: string;
  status: ProbeStatus;
  detail: string;
}

interface ModelConfig {
  provider: "ollama" | "anthropic" | "openai" | "gemini" | "copilot";
  model: string;
  base_url?: string;
  api_key?: string;
}

function hasFlag(flag: string): boolean {
  return Bun.argv.includes(flag);
}

function trimYamlValue(raw: string): string {
  const noComment = raw.split("#")[0] ?? "";
  return noComment.trim().replace(/^"|"$/g, "");
}

function resolveEnvTemplate(value: string): string {
  const match = value.match(/^\$\{([^}:]+):-([^}]*)\}$/);
  if (!match) return value;
  const name = match[1];
  const fallback = match[2] ?? "";
  return process.env[name] ?? fallback;
}

function parseModels(raw: string): Record<string, ModelConfig> {
  const lines = raw.split("\n");
  const models: Record<string, ModelConfig> = {};
  let inModels = false;
  let currentAlias = "";

  for (const line of lines) {
    if (!inModels) {
      if (/^models:\s*$/.test(line)) inModels = true;
      continue;
    }

    if (/^[^\s#].*:\s*$/.test(line)) break;
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;

    const aliasMatch = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*$/);
    if (aliasMatch) {
      currentAlias = aliasMatch[1] ?? "";
      if (currentAlias) {
        models[currentAlias] = { provider: "ollama", model: "" };
      }
      continue;
    }

    const keyMatch = line.match(/^\s{4}([a-z_]+):\s*(.+)$/);
    if (!keyMatch || !currentAlias) continue;

    const key = keyMatch[1] ?? "";
    const value = resolveEnvTemplate(trimYamlValue(keyMatch[2] ?? ""));
    const model = models[currentAlias];
    if (!model) continue;

    if (key === "provider") {
      model.provider = value as ModelConfig["provider"];
    }
    if (key === "model") {
      model.model = value;
    }
    if (key === "base_url") {
      model.base_url = value;
    }
    if (key === "api_key") {
      model.api_key = value;
    }
  }

  return Object.fromEntries(Object.entries(models).filter(([, model]) => model.model));
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function probeOllama(alias: string, model: ModelConfig): Promise<ProbeResult> {
  const base = (model.base_url ?? "http://localhost:11434").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: withTimeout(8_000) });
    if (!res.ok) {
      return { alias, provider: model.provider, status: "fail", detail: `HTTP ${res.status} from ${base}/api/tags` };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const present = (data.models ?? []).some((entry) =>
      entry.name.startsWith(model.model.split(":")[0] ?? model.model),
    );
    return {
      alias,
      provider: model.provider,
      status: present ? "pass" : "fail",
      detail: present ? `model ${model.model} detected` : `model ${model.model} missing in tags`,
    };
  } catch (error) {
    return { alias, provider: model.provider, status: "fail", detail: String(error) };
  }
}

async function probeAnthropic(alias: string, model: ModelConfig): Promise<ProbeResult> {
  if (!model.api_key) {
    return { alias, provider: model.provider, status: "skip", detail: "missing api_key" };
  }
  const base = (model.base_url ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      headers: { "x-api-key": model.api_key, "anthropic-version": "2023-06-01" },
      signal: withTimeout(8_000),
    });
    return {
      alias,
      provider: model.provider,
      status: res.ok ? "pass" : "fail",
      detail: res.ok ? "models endpoint reachable" : `HTTP ${res.status}`,
    };
  } catch (error) {
    return { alias, provider: model.provider, status: "fail", detail: String(error) };
  }
}

async function probeOpenAICompatible(alias: string, model: ModelConfig): Promise<ProbeResult> {
  if (!model.api_key) {
    return { alias, provider: model.provider, status: "skip", detail: "missing api_key" };
  }

  const defaultBase = model.provider === "copilot" ? "https://api.githubcopilot.com" : "https://api.openai.com/v1";
  const base = (model.base_url ?? defaultBase).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${model.api_key}` },
      signal: withTimeout(8_000),
    });
    return {
      alias,
      provider: model.provider,
      status: res.ok ? "pass" : "fail",
      detail: res.ok ? "models endpoint reachable" : `HTTP ${res.status}`,
    };
  } catch (error) {
    return { alias, provider: model.provider, status: "fail", detail: String(error) };
  }
}

async function probeGemini(alias: string, model: ModelConfig): Promise<ProbeResult> {
  if (!model.api_key) {
    return { alias, provider: model.provider, status: "skip", detail: "missing api_key" };
  }

  const base = (model.base_url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/models?key=${encodeURIComponent(model.api_key)}`, { signal: withTimeout(8_000) });
    return {
      alias,
      provider: model.provider,
      status: res.ok ? "pass" : "fail",
      detail: res.ok ? "models endpoint reachable" : `HTTP ${res.status}`,
    };
  } catch (error) {
    return { alias, provider: model.provider, status: "fail", detail: String(error) };
  }
}

async function probeModel(alias: string, model: ModelConfig): Promise<ProbeResult> {
  if (model.provider === "ollama") return probeOllama(alias, model);
  if (model.provider === "anthropic") return probeAnthropic(alias, model);
  if (model.provider === "openai" || model.provider === "copilot") return probeOpenAICompatible(alias, model);
  return probeGemini(alias, model);
}

async function main(): Promise<void> {
  const strict = hasFlag("--strict");
  const raw = await Bun.file("./companion.yaml").text();
  const models = parseModels(raw);

  const probes = Object.entries(models).map(([alias, model]) => probeModel(alias, model));
  const results = await Promise.all(probes);

  const summary = {
    timestamp: new Date().toISOString(),
    strict,
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  const failed = results.some((result) => result.status === "fail");
  const skipped = results.some((result) => result.status === "skip");
  if (strict && (failed || skipped)) {
    process.exit(1);
  }
}

await main();
