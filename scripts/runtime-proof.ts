export {};

/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface SandboxConfig {
  runtime?: string;
  allow_direct_fallback?: boolean;
  image?: string;
}

interface ParsedRuntimeConfig {
  serverSecret: string;
  sandbox: SandboxConfig;
  modeDefault: string;
}

function getArgFlag(flag: string): boolean {
  return Bun.argv.includes(flag);
}

async function runProbe(command: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
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

function extractScalar(source: string, key: string, fallback: string): string {
  const regex = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m");
  const match = source.match(regex);
  if (!match) return fallback;
  return resolveEnvTemplate(trimYamlValue(match[1] ?? "")) || fallback;
}

function extractBoolean(source: string, key: string, fallback: boolean): boolean {
  const value = extractScalar(source, key, fallback ? "true" : "false").toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function parseRuntimeConfig(raw: string): ParsedRuntimeConfig {
  return {
    serverSecret: extractScalar(raw, "secret", "dev-secret"),
    sandbox: {
      runtime: extractScalar(raw, "runtime", "auto"),
      allow_direct_fallback: extractBoolean(raw, "allow_direct_fallback", true),
      image: extractScalar(raw, "image", "companion-sandbox:latest"),
    },
    modeDefault: extractScalar(raw, "default", "local"),
  };
}

async function detectSandboxStrategy(sandbox: SandboxConfig): Promise<{ status: CheckStatus; detail: string }> {
  const runtime = sandbox.runtime ?? "auto";
  const allowDirect = sandbox.allow_direct_fallback ?? true;
  const image = sandbox.image ?? "companion-sandbox:latest";

  if (runtime === "direct") {
    return { status: "warn", detail: "runtime=direct (host execution, no container isolation)" };
  }

  const runtimes = runtime === "auto" ? ["docker", "podman", "nerdctl"] : [runtime];
  for (const candidate of runtimes) {
    const available = await runProbe([candidate, "info"]);
    if (!available) continue;

    const imageCheck =
      candidate === "podman" ? [candidate, "image", "exists", image] : [candidate, "image", "inspect", image];
    const hasImage = await runProbe(imageCheck);
    if (hasImage) {
      return { status: "pass", detail: `container runtime=${candidate}, image=${image}` };
    }
    return {
      status: allowDirect ? "warn" : "fail",
      detail: `runtime=${candidate} available but image ${image} missing`,
    };
  }

  return {
    status: allowDirect ? "warn" : "fail",
    detail: allowDirect
      ? "no container runtime found; direct fallback active"
      : "no container runtime found; execution refused",
  };
}

async function main(): Promise<void> {
  const strict = getArgFlag("--strict");
  const raw = await Bun.file("./companion.yaml").text();
  const parsed = parseRuntimeConfig(raw);

  const checks: CheckResult[] = [];

  checks.push({
    name: "server_secret",
    status: parsed.serverSecret && parsed.serverSecret !== "dev-secret" ? "pass" : "warn",
    detail: parsed.serverSecret && parsed.serverSecret !== "dev-secret" ? "custom secret set" : "default secret in use",
  });

  checks.push({
    name: "sandbox_runtime",
    status:
      parsed.sandbox.runtime === "docker" || parsed.sandbox.runtime === "podman" || parsed.sandbox.runtime === "nerdctl"
        ? "pass"
        : "warn",
    detail: `runtime=${parsed.sandbox.runtime}`,
  });

  checks.push({
    name: "sandbox_direct_fallback",
    status: parsed.sandbox.allow_direct_fallback ? "warn" : "pass",
    detail: `allow_direct_fallback=${parsed.sandbox.allow_direct_fallback}`,
  });

  const strategy = await detectSandboxStrategy(parsed.sandbox);
  checks.push({ name: "sandbox_probe", status: strategy.status, detail: strategy.detail });

  const summary = {
    timestamp: new Date().toISOString(),
    mode_default: parsed.modeDefault,
    strict,
    checks,
  };

  console.log(JSON.stringify(summary, null, 2));

  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  if (strict && (failed || warned)) {
    process.exit(1);
  }
}

await main();
