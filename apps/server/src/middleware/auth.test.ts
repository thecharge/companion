/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { isAuthorizedRequest, isPublicIntegrationWebhook } from "./auth";

const buildConfig = (secret: string) => ({ server: { secret } }) as unknown as import("@companion/config").Config;

describe("auth middleware", () => {
  test("accepts bearer token", () => {
    const req = new Request("http://localhost", { headers: { Authorization: "Bearer abc" } });
    expect(isAuthorizedRequest(req, buildConfig("abc"))).toBe(true);
  });

  test("accepts raw api key header", () => {
    const req = new Request("http://localhost", { headers: { "x-api-key": "abc" } });
    expect(isAuthorizedRequest(req, buildConfig("abc"))).toBe(true);
  });

  test("rejects invalid secret", () => {
    const req = new Request("http://localhost", { headers: { Authorization: "Bearer wrong" } });
    expect(isAuthorizedRequest(req, buildConfig("abc"))).toBe(false);
  });

  test("allows public integration webhook posts", () => {
    const req = new Request("http://localhost/integrations/slack/events", { method: "POST" });
    expect(isPublicIntegrationWebhook(req)).toBe(true);
    expect(isAuthorizedRequest(req, buildConfig("abc"))).toBe(true);
  });

  test("does not allow integration path on non-post methods", () => {
    const req = new Request("http://localhost/integrations/slack/events", { method: "GET" });
    expect(isPublicIntegrationWebhook(req)).toBe(false);
  });
});
