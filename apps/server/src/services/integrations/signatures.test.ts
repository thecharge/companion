/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "./signatures";

describe("slack signature verification", () => {
  test("accepts valid signature", () => {
    const secret = "test-secret";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "event_callback" });
    const payload = `v0:${ts}:${body}`;
    const signature = `v0=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifySlackSignature(secret, ts, signature, body)).toBe(true);
  });

  test("rejects invalid signature", () => {
    const secret = "test-secret";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "event_callback" });

    expect(verifySlackSignature(secret, ts, "v0=bad", body)).toBe(false);
  });
});
