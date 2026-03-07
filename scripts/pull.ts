#!/usr/bin/env bun
/**
 * Pull all Ollama models defined in companion.yaml.
 *
 * Usage:
 *   bun run scripts/pull.ts
 *
 * - Skips non-Ollama models silently
 * - Checks if model is already present before pulling (idempotent)
 * - Streams pull progress to stdout
 * - Exits 1 if Ollama is not reachable
 */

import { loadConfig } from "../packages/config/src/index";

const cfg = await loadConfig("./companion.yaml");

const ollamaModels = Object.entries(cfg.models).filter(([, m]) => m.provider === "ollama");

if (ollamaModels.length === 0) {
  console.log("No Ollama models configured — nothing to pull.");
  process.exit(0);
}

for (const [alias, modelCfg] of ollamaModels) {
  const base = (modelCfg.base_url ?? "http://localhost:11434").replace(/\/$/, "");

  // 1. Check Ollama is reachable
  let available: string[] = [];
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    available = data.models?.map((m) => m.name) ?? [];
  } catch (e) {
    console.error(`\n[error] Ollama not reachable at ${base} for alias "${alias}".`);
    console.error(`        Start it with: ollama serve`);
    console.error(`        Error: ${e}`);
    process.exit(1);
  }

  // 2. Check if already present (match by name prefix, e.g. "qwen3:1.7b" matches "qwen3:1.7b")
  const alreadyPresent = available.some(
    (n) => n === modelCfg.model || n.startsWith(modelCfg.model.split(":")[0]! + ":"),
  );

  if (alreadyPresent) {
    console.log(`[ok]   "${modelCfg.model}" (alias: ${alias}) — already present`);
    continue;
  }

  // 3. Pull with streaming progress
  console.log(`[pull] "${modelCfg.model}" (alias: ${alias}) — pulling...`);

  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelCfg.model, stream: true }),
    signal: AbortSignal.timeout(1800_000), // 30min max for large models
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    console.error(`[error] Pull failed for "${modelCfg.model}": HTTP ${res.status} ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let lastStatus = "";
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as {
          status: string;
          completed?: number;
          total?: number;
          digest?: string;
        };

        // Only print when status changes — avoids flooding with byte-progress lines
        const statusKey = `${evt.status}:${evt.digest ?? ""}`;
        if (statusKey !== lastStatus) {
          if (evt.total && evt.completed) {
            const pct = ((evt.completed / evt.total) * 100).toFixed(1);
            process.stdout.write(`\r       ${evt.status} ${pct}%   `);
          } else {
            process.stdout.write(`\n       ${evt.status}`);
          }
          lastStatus = statusKey;
        }
      } catch {
        // Non-JSON line from Ollama — ignore
      }
    }
  }

  process.stdout.write("\n");
  console.log(`[done] "${modelCfg.model}" pulled successfully`);
}

console.log("\nAll Ollama models ready.");
