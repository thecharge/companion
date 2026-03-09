/**
 * @companion/config
 *
 * Loads companion.yaml, interpolates ${ENV_VAR:-default} expressions,
 * validates with Zod, and exposes a typed Config + runtime patch store.
 */

import { readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────

// ── Sandbox schema ────────────────────────────────────────────
//
// Controls how run_shell and run_tests execute commands.
//
//   runtime:
//     "auto"    — probe docker → podman → nerdctl in order; use first available
//     "docker"  — require docker; error if not found
//     "podman"  — require podman; error if not found
//     "nerdctl" — require nerdctl (containerd CLI); error if not found
//     "direct"  — skip containers entirely, run in host shell (no isolation)
//
//   allow_direct_fallback:
//     true  — if "auto" finds no container runtime, warn and run directly
//     false — if "auto" finds no container runtime, refuse to execute (safer)
//
//   image:
//     OCI image used when a container runtime is available.
//     Build with:  docker build -t companion-sandbox:latest ./sandbox
//     Skip image building:  set runtime to "direct" (dev only)
//
//   network:
//     "none"  — no network inside container (default, safest)
//     "host"  — share host network (e.g. when tool needs localhost services)
//     "bridge" — standard Docker bridge NAT

export const SandboxRuntimeSchema = z.enum(["auto", "docker", "podman", "nerdctl", "direct"]);
export type SandboxRuntime = z.infer<typeof SandboxRuntimeSchema>;

const SandboxNetworkSchema = z.enum(["none", "host", "bridge"]).default("none");

const SandboxSchema = z.object({
  runtime: SandboxRuntimeSchema.default("auto"),
  allow_direct_fallback: z.boolean().default(true),
  image: z.string().default("companion-sandbox:latest"),
  network: SandboxNetworkSchema,
  timeout_seconds: z.number().int().positive().default(30),
  tests_timeout_seconds: z.number().int().positive().default(120),
});

export type SandboxConfig = z.infer<typeof SandboxSchema>;

const ModelSchema = z.object({
  provider: z.enum(["ollama", "anthropic", "openai", "gemini", "copilot", "grok"]),
  model: z.string(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  max_tokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.2),
});

const AgentSchema = z.object({
  model: z.string(),
  description: z.string(),
  tools: z.array(z.string()).default([]),
  reads_from: z.array(z.string()).default([]),
  writes_to: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().default(8),
});

const WorkflowTrackSchema = z.object({
  triggers: z.array(z.string()).default([]),
  stages: z.array(z.string()).default([]),
});

const IntegrationsSchema = z.object({
  slack: z
    .object({
      enabled: z.coerce.boolean().default(false),
      bot_token: z.string().optional(),
      signing_secret: z.string().optional(),
      mode: z.string().optional(),
      default_session_title: z.string().default("Slack Session"),
      max_message_chars: z.number().int().positive().default(2000),
      max_events_per_minute: z.number().int().positive().default(30),
    })
    .default({}),
  telegram: z
    .object({
      enabled: z.coerce.boolean().default(false),
      bot_token: z.string().optional(),
      secret_token: z.string().optional(),
      mode: z.string().optional(),
      default_session_title: z.string().default("Telegram Session"),
      max_message_chars: z.number().int().positive().default(2000),
      max_events_per_minute: z.number().int().positive().default(30),
    })
    .default({}),
});

const ConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().default(3000),
    host: z.string().default("0.0.0.0"),
    secret: z.string().default("dev-secret"),
  }),

  db: z.object({
    driver: z.enum(["sqlite", "postgres"]).default("sqlite"),
    sqlite: z.object({ path: z.string().default("./data/companion.db") }),
    postgres: z.object({ url: z.string().default("") }).optional(),
  }),

  vector: z.object({
    backend: z.enum(["sqlite-vec", "qdrant"]).default("sqlite-vec"),
    qdrant: z.object({ url: z.string(), collection: z.string() }).optional(),
    embedding: z.object({
      model: z.string().default("nomic-embed-text"),
      dimensions: z.number().int().positive().default(768),
    }),
  }),

  models: z.record(z.string(), ModelSchema),

  orchestrator: z.object({
    model: z.string().default("local"),
    max_rounds: z.number().int().positive().default(10),
    verify_results: z.boolean().default(true),
    workflow_tracks: z.record(z.string(), WorkflowTrackSchema).default({}),
  }),

  agents: z.record(z.string(), AgentSchema),
  agents_dir: z.string().optional(),

  memory: z.object({
    context_window: z.object({
      max_messages: z.number().int().positive().default(40),
      max_tokens: z.number().int().positive().default(8000),
    }),
    sliding_window: z.object({
      chunk_size: z.number().int().positive().default(2000),
      page_size: z.number().int().positive().default(20),
    }),
    recall: z.object({
      top_k: z.number().int().positive().default(5),
      min_score: z.number().min(0).max(1).default(0.72),
      cross_session: z.boolean().default(false),
    }),
    summarisation: z.object({
      enabled: z.boolean().default(true),
      trigger_at_messages: z.number().int().positive().default(60),
      model: z.string().default("fast"),
    }),
  }),

  mode: z.object({
    default: z.string().default("local"),
    presets: z.record(z.string(), z.object({ description: z.string() })),
  }),

  integrations: IntegrationsSchema.default({}),

  tools: z
    .record(
      z.string(),
      z.object({
        image: z.string().optional(),
        timeout_seconds: z.number().int().positive().default(30),
        allow_network: z.boolean().default(false),
      }),
    )
    .default({}),

  sandbox: SandboxSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type ConfigPatch = Partial<{
  orchestrator: Partial<Config["orchestrator"]>;
  memory: Partial<Config["memory"]>;
  mode: Partial<Config["mode"]>;
}>;

// ── Env interpolation ─────────────────────────────────────────

function interpolate(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [varName, ...rest] = expr.split(":-");
    if (!varName) return "";
    const fallback = rest.join(":-");
    return process.env[varName] ?? fallback ?? "";
  });
}

function walkInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolate(obj);
  if (Array.isArray(obj)) return obj.map(walkInterpolate);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, walkInterpolate(v)]));
  }
  return obj;
}

const OVERRIDE_CANDIDATES = ["companion.override.yaml", "companion.override.yml", ".companion/companion.yaml"];

// ── Loader ────────────────────────────────────────────────────

export async function loadConfig(path = "./companion.yaml"): Promise<Config> {
  const absPath = resolve(path);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`companion.yaml not found at ${path}`);
  }
  const raw = await file.text();
  const obj = walkInterpolate(parseYaml(raw)) as Record<string, unknown>;

  if (typeof obj.agents_dir === "string") {
    const baseDir = dirname(absPath);
    const mergedAgents = await loadAgentsFromDirectory(baseDir, obj.agents_dir);
    obj.agents = deepMerge(obj.agents ?? {}, mergedAgents);
  }

  const result = ConfigSchema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }
  return result.data;
}

export async function findNearestOverridePath(workingDir: string, stopDir?: string): Promise<string | undefined> {
  let current = resolve(workingDir);
  const stop = stopDir ? resolve(stopDir) : undefined;

  while (true) {
    for (const candidate of OVERRIDE_CANDIDATES) {
      const candidatePath = join(current, candidate);
      if (await Bun.file(candidatePath).exists()) {
        return candidatePath;
      }
    }

    if (stop && current === stop) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function loadConfigOverride(path: string): Promise<Partial<Config>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`override config not found at ${path}`);
  }
  const raw = await file.text();
  const obj = walkInterpolate(parseYaml(raw));
  if (!obj || typeof obj !== "object") return {};
  return obj as Partial<Config>;
}

export async function resolveWorkingDirConfig(
  base: Config,
  workingDir: string,
  rootConfigPath?: string,
): Promise<Config> {
  const rootDir = rootConfigPath ? dirname(resolve(rootConfigPath)) : process.cwd();
  const overridePath = await findNearestOverridePath(workingDir, rootDir);
  if (!overridePath) return base;

  const override = await loadConfigOverride(overridePath);
  const merged = deepMerge(base, override);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Working-dir override validation failed (${overridePath}):\n${issues}`);
  }
  return result.data;
}

async function loadAgentsFromDirectory(
  configDir: string,
  agentsDir: string,
): Promise<Record<string, Record<string, unknown>>> {
  const fullDir = resolve(configDir, agentsDir);
  const entries = await readdir(fullDir, { withFileTypes: true });
  const merged: Record<string, Record<string, unknown>> = {};

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") continue;

    const filePath = join(fullDir, entry.name);
    const raw = await Bun.file(filePath).text();
    const parsed = walkInterpolate(parseYaml(raw)) as Record<string, unknown>;
    const fromFile = parseAgentFile(parsed);
    Object.assign(merged, fromFile);
  }

  return merged;
}

function parseAgentFile(input: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (isRecord(input.agents)) {
    return input.agents as Record<string, Record<string, unknown>>;
  }

  if (typeof input.name === "string" && isRecord(input)) {
    const { name, ...rest } = input;
    return { [name]: rest };
  }

  const keys = Object.keys(input);
  if (keys.length === 1) {
    const key = keys[0];
    if (key && isRecord(input[key])) {
      return { [key]: input[key] as Record<string, unknown> };
    }
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Runtime config store (per-session overrides + global patches) ─

export class ConfigStore {
  private base: Config;
  private global: ConfigPatch = {};
  private sessions: Map<string, ConfigPatch> = new Map();

  constructor(base: Config) {
    this.base = base;
  }

  /** Get effective config for a session */
  get(sessionId?: string): Config {
    const s = sessionId ? (this.sessions.get(sessionId) ?? {}) : {};
    return deepMerge(deepMerge(this.base, this.global), s) as Config;
  }

  /** Patch global config at runtime */
  patch(p: ConfigPatch): void {
    this.global = deepMerge(this.global, p) as ConfigPatch;
  }

  /** Patch a single session's config */
  patchSession(sessionId: string, p: ConfigPatch): void {
    const existing = this.sessions.get(sessionId) ?? {};
    this.sessions.set(sessionId, deepMerge(existing, p) as ConfigPatch);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || patch === undefined || typeof patch !== "object" || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    result[k] = deepMerge(result[k], v);
  }
  return result;
}
