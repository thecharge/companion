import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "./index";

const OVERRIDE_CANDIDATES = ["companion.override.yaml", "companion.override.yml", ".companion/companion.yaml"] as const;

const interpolate = (raw: string): string => {
  return raw.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [varName, ...rest] = expr.split(":-");
    if (!varName) return "";
    const fallback = rest.join(":-");
    return process.env[varName] ?? fallback ?? "";
  });
};

const walkInterpolate = (obj: unknown): unknown => {
  if (typeof obj === "string") return interpolate(obj);
  if (Array.isArray(obj)) return obj.map(walkInterpolate);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, walkInterpolate(v)]));
  }
  return obj;
};

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
