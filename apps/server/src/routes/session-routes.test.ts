/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import type { AppContext } from "../bootstrap/app-context";
import { HeaderName, HttpStatus } from "../constants/http";
import { handleSessionRoutes } from "./session-routes";

function createTestContext() {
  let createCalls = 0;
  const created = {
    id: "s-test",
    title: "New Session",
    goal: "New Session",
    mode: "local",
    status: "active",
    blackboard: "{}",
    summary: "",
    message_count: 0,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const ctx = {
    cfg: {
      mode: { default: "local" },
      server: {
        idempotency: { enabled: true, ttl_seconds: 3600, max_entries: 128 },
      },
    },
    db: {
      sessions: {
        list: async () => [],
        create: async () => {
          createCalls += 1;
          return created;
        },
        get: async () => null,
      },
      messages: {
        list: async () => [],
      },
    },
    activeCancels: new Map(),
  } as unknown as AppContext;

  const auditLogService = {
    recordHttpEvent: async () => {},
  };

  return { ctx, auditLogService, getCreateCalls: () => createCalls, created };
}

describe("session routes idempotency", () => {
  test("replays session create for same idempotency key and payload", async () => {
    const { ctx, auditLogService, getCreateCalls, created } = createTestContext();

    const reqA = new Request("http://localhost:3000/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HeaderName.IdempotencyKey]: "create-1",
      },
      body: JSON.stringify({ title: "A", goal: "A", mode: "local" }),
    });

    const reqB = new Request("http://localhost:3000/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HeaderName.IdempotencyKey]: "create-1",
      },
      body: JSON.stringify({ title: "A", goal: "A", mode: "local" }),
    });

    const a = await handleSessionRoutes(reqA, ctx, {} as never, auditLogService as never);
    const b = await handleSessionRoutes(reqB, ctx, {} as never, auditLogService as never);

    expect(a?.status).toBe(HttpStatus.Created);
    expect(b?.status).toBe(HttpStatus.Created);
    expect(b?.headers.get(HeaderName.IdempotentReplay)).toBe("true");
    expect(getCreateCalls()).toBe(1);

    const payload = (await b?.json()) as { session: { id: string } };
    expect(payload.session.id).toBe(created.id);
  });

  test("rejects idempotency key reuse with different payload", async () => {
    const { ctx, auditLogService } = createTestContext();

    const reqA = new Request("http://localhost:3000/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HeaderName.IdempotencyKey]: "create-2",
      },
      body: JSON.stringify({ title: "A" }),
    });

    const reqB = new Request("http://localhost:3000/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HeaderName.IdempotencyKey]: "create-2",
      },
      body: JSON.stringify({ title: "B" }),
    });

    await handleSessionRoutes(reqA, ctx, {} as never, auditLogService as never);
    const replay = await handleSessionRoutes(reqB, ctx, {} as never, auditLogService as never);

    expect(replay?.status).toBe(HttpStatus.BadRequest);
  });
});
