/**
 * @companion/config
 *
 * Loads companion.yaml, interpolates ${ENV_VAR:-default} expressions,
 * validates with Zod, and exposes a typed Config + runtime patch store.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────

const ModelSchema = z.object({
  provider:    z.enum(["ollama", "anthropic", "openai", "gemini", "copilot"]),
  model:       z.string(),
  base_url:    z.string().optional(),
  api_key:     z.string().optional(),
  max_tokens:  z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.2),
});

const AgentSchema = z.object({
  model:       z.string(),
  description: z.string(),
  tools:       z.array(z.string()).default([]),
  reads_from:  z.array(z.string()).default([]),
  writes_to:   z.array(z.string()).default([]),
  max_turns:   z.number().int().positive().default(8),
});

const ConfigSchema = z.object({
  server: z.object({
    port:   z.coerce.number().int().default(3000),
    host:   z.string().default("0.0.0.0"),
    secret: z.string().default("dev-secret"),
  }),

  db: z.object({
    driver: z.enum(["sqlite", "postgres"]).default("sqlite"),
    sqlite: z.object({ path: z.string().default("./data/companion.db") }),
    postgres: z.object({ url: z.string().default("") }).optional(),
  }),

  vector: z.object({
    backend: z.enum(["sqlite-vec", "qdrant"]).default("sqlite-vec"),
    qdrant: z
      .object({ url: z.string(), collection: z.string() })
      .optional(),
    embedding: z.object({
      model:      z.string().default("nomic-embed-text"),
      dimensions: z.number().int().positive().default(768),
    }),
  }),

  models: z.record(z.string(), ModelSchema),

  orchestrator: z.object({
    model:          z.string().default("local"),
    max_rounds:     z.number().int().positive().default(10),
    verify_results: z.boolean().default(true),
  }),

  agents: z.record(z.string(), AgentSchema),

  memory: z.object({
    context_window: z.object({
      max_messages: z.number().int().positive().default(40),
      max_tokens:   z.number().int().positive().default(8000),
    }),
    sliding_window: z.object({
      chunk_size: z.number().int().positive().default(2000),
      page_size:  z.number().int().positive().default(20),
    }),
    recall: z.object({
      top_k:         z.number().int().positive().default(5),
      min_score:     z.number().min(0).max(1).default(0.72),
      cross_session: z.boolean().default(false),
    }),
    summarisation: z.object({
      enabled:             z.boolean().default(true),
      trigger_at_messages: z.number().int().positive().default(60),
      model:               z.string().default("fast"),
    }),
  }),

  mode: z.object({
    default: z.string().default("local"),
    presets: z.record(z.string(), z.object({ description: z.string() })),
  }),

  tools: z.record(
    z.string(),
    z.object({
      image:           z.string().optional(),
      timeout_seconds: z.number().int().positive().default(30),
      allow_network:   z.boolean().default(false),
    }),
  ).default({}),
});

export type Config      = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type ConfigPatch = Partial<{
  orchestrator: Partial<Config["orchestrator"]>;
  memory:       Partial<Config["memory"]>;
  mode:         Partial<Config["mode"]>;
}>;

// ── Env interpolation ─────────────────────────────────────────

function interpolate(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [varName, ...rest] = expr.split(":-");
    const fallback = rest.join(":-");
    return process.env[varName!] ?? fallback ?? "";
  });
}

function walkInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolate(obj);
  if (Array.isArray(obj)) return obj.map(walkInterpolate);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, walkInterpolate(v)]),
    );
  }
  return obj;
}

// ── Loader ────────────────────────────────────────────────────

export async function loadConfig(path = "./companion.yaml"): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`companion.yaml not found at ${path}`);
  }
  const raw  = await file.text();
  const obj  = walkInterpolate(parseYaml(raw));
  const result = ConfigSchema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }
  return result.data;
}

// ── Runtime config store (per-session overrides + global patches) ─

export class ConfigStore {
  private base:     Config;
  private global:   ConfigPatch = {};
  private sessions: Map<string, ConfigPatch> = new Map();

  constructor(base: Config) {
    this.base = base;
  }

  /** Get effective config for a session */
  get(sessionId?: string): Config {
    const s   = sessionId ? (this.sessions.get(sessionId) ?? {}) : {};
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
  if (
    patch === null ||
    patch === undefined ||
    typeof patch !== "object" ||
    Array.isArray(patch)
  )
    return patch ?? base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    result[k] = deepMerge(result[k], v);
  }
  return result;
}
