/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { buildIdempotencyKey } from "./idempotency-key";

describe("buildIdempotencyKey", () => {
  test("is deterministic for same scope and payload", () => {
    const a = buildIdempotencyKey("session-message", {
      sessionId: "s1",
      content: "check system load",
      stream: true,
      working_dir: "/tmp",
    });

    const b = buildIdempotencyKey("session-message", {
      working_dir: "/tmp",
      stream: true,
      content: "check system load",
      sessionId: "s1",
    });

    expect(a).toBe(b);
  });

  test("changes with scope or payload", () => {
    const base = buildIdempotencyKey("session-message", { sessionId: "s1", content: "hello" });
    const changedPayload = buildIdempotencyKey("session-message", { sessionId: "s1", content: "hello again" });
    const changedScope = buildIdempotencyKey("session-create", { sessionId: "s1", content: "hello" });

    expect(base).not.toBe(changedPayload);
    expect(base).not.toBe(changedScope);
  });
});
