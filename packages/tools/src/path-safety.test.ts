/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { safePath } from "./path-safety";

describe("path safety", () => {
  test("resolves absolute paths without duplicating working directory", () => {
    const workingDir = "/tmp";
    const absolute = "/tmp/test.log";

    expect(safePath(workingDir, absolute)).toBe(absolute);
  });

  test("resolves relative paths against working directory", () => {
    const workingDir = "/tmp";
    const rel = "logs/test.log";

    expect(safePath(workingDir, rel)).toBe(join(workingDir, rel));
  });

  test("rejects paths outside safe base and working directory", () => {
    const workingDir = "/tmp/companion-safe";

    expect(() => safePath(workingDir, "/etc/passwd")).toThrow(/SECURITY/);
  });
});
