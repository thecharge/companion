/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { loadSkillsDir } from "./index";

describe("skills loader", () => {
  test("returns empty for missing directory", async () => {
    const skills = await loadSkillsDir("./does-not-exist");
    expect(skills).toEqual([]);
  });
});
