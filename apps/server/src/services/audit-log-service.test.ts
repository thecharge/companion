/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogService } from "./audit-log-service";

describe("audit log service", () => {
  test("writes and reads recent records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-audit-"));
    const logPath = join(dir, "audit.ndjson");
    const service = new AuditLogService(logPath);

    await service.initialize();
    await service.record({
      timestamp: new Date().toISOString(),
      category: "http",
      action: "sessions_list",
      status: "ok",
    });

    const records = await service.listRecent(10);
    expect(records.length).toBe(1);
    expect(records[0]?.action).toBe("sessions_list");

    await rm(dir, { recursive: true, force: true });
  });
});
