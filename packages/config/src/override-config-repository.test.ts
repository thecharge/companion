import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNearestOverridePath, loadConfigOverride } from "./override-config-repository";

describe("override config repository", () => {
  test("finds nearest override file while walking up", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-override-find-"));
    const nested = join(root, "apps", "api", "src");
    await mkdir(nested, { recursive: true });
    const overridePath = join(root, "apps", "companion.override.yaml");
    await writeFile(overridePath, "mode:\n  default: cloud\n");

    try {
      const found = await findNearestOverridePath(nested, root);
      expect(found).toBe(overridePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads override and resolves env template fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-override-load-"));
    const overridePath = join(root, "companion.override.yaml");
    await writeFile(overridePath, "server:\n  host: ${MISSING_HOST:-127.0.0.1}\n");

    try {
      const loaded = await loadConfigOverride(overridePath);
      expect(loaded.server?.host).toBe("127.0.0.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
