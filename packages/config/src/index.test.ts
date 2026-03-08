/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { ConfigStore, loadConfig } from "./index";

describe("config", () => {
  test("loads workspace config", async () => {
    const cfg = await loadConfig("../../companion.yaml");
    expect(cfg.server.port).toBeNumber();
    expect(cfg.models.local?.provider).toBe("ollama");
  });

  test("config store returns patched mode", async () => {
    const cfg = await loadConfig("../../companion.yaml");
    const store = new ConfigStore(cfg);
    const sid = "session-1";
    store.patchSession(sid, { mode: { default: "cloud" } });
    expect(store.get(sid).mode.default).toBe("cloud");
  });
});
