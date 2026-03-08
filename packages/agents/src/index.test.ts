/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { SessionProcessor } from "./index";

describe("agents exports", () => {
  test("SessionProcessor is constructable", () => {
    expect(typeof SessionProcessor).toBe("function");
  });
});
