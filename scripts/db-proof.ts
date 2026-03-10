/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { loadConfig } from "../packages/config/src/index.ts";
import { asMessage, asSession, newId } from "../packages/core/src/index.ts";
import { AuditLogRepository, createDB, createVectorStore } from "../packages/db/src/index.ts";

type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function hasFlag(flag: string): boolean {
  return Bun.argv.includes(flag);
}

function buildPrefix(): string {
  return `proof-${Date.now().toString(36)}-${newId().slice(0, 8)}`;
}

async function runDbCrudCheck(checks: CheckResult[]): Promise<void> {
  const cfg = await loadConfig("./companion.yaml");
  const db = await createDB(cfg);
  const prefix = buildPrefix();
  const sessionId = asSession(`${prefix}-session`);
  const messageId = asMessage(`${prefix}-msg`);

  try {
    await db.sessions.create(sessionId, "Proof Session", "proof", "local");
    await db.messages.add({ id: messageId, session_id: sessionId, role: "user", content: "proof-message" });

    const loaded = await db.sessions.get(sessionId);
    const messages = await db.messages.list(sessionId, { limit: 5 });

    const ok = Boolean(loaded) && messages.some((msg) => msg.id === messageId);
    checks.push({
      name: "db_crud",
      status: ok ? "pass" : "fail",
      detail: ok ? `driver=${cfg.db.driver} create/read checks passed` : "session/message verification failed",
    });
  } catch (error) {
    checks.push({ name: "db_crud", status: "fail", detail: String(error) });
  } finally {
    await db.sessions.delete(sessionId).catch(() => {});
    db.close();
  }
}

async function runVectorCheck(checks: CheckResult[]): Promise<void> {
  const cfg = await loadConfig("./companion.yaml");
  const vectorStore = createVectorStore(cfg);
  const prefix = buildPrefix();
  const vectorId = `${prefix}-vec`;
  const sessionId = `${prefix}-vector-session`;

  try {
    await vectorStore.upsert({
      id: vectorId,
      session_id: sessionId,
      content: "proof-vector",
      embedding: [1, 0, 0],
      metadata: { source: "db-proof" },
    });

    const rows = await vectorStore.search(sessionId, [1, 0, 0], 3, 0.1);
    const ok = rows.some((row) => row.id === vectorId);

    checks.push({
      name: "vector_store",
      status: ok ? "pass" : "fail",
      detail: ok ? `backend=${cfg.vector.backend} retrieval passed` : "vector retrieval failed",
    });
  } catch (error) {
    checks.push({ name: "vector_store", status: "fail", detail: String(error) });
  } finally {
    await vectorStore.delete(vectorId).catch(() => {});
    await vectorStore.deleteSession(sessionId).catch(() => {});
  }
}

async function runAuditCheck(checks: CheckResult[]): Promise<void> {
  const cfg = await loadConfig("./companion.yaml");
  const repository = new AuditLogRepository({
    cfg,
    mirrorPath: "./tmp/proof-audit.ndjson",
    rotateBytes: 256,
    rotateFiles: 2,
    maxRows: 1000,
  });

  try {
    await repository.initialize();
    await repository.record({
      timestamp: new Date().toISOString(),
      category: "http",
      action: "db_proof",
      status: "ok",
      metadata: { source: "proof" },
    });

    const events = await repository.listRecent(5);
    const ok = events.some((event) => event.action === "db_proof");

    checks.push({
      name: "audit_store",
      status: ok ? "pass" : "fail",
      detail: ok ? "audit repository write/read passed" : "audit repository verification failed",
    });
  } catch (error) {
    checks.push({ name: "audit_store", status: "fail", detail: String(error) });
  }
}

async function main(): Promise<void> {
  const strict = hasFlag("--strict");
  const checks: CheckResult[] = [];

  await runDbCrudCheck(checks);
  await runVectorCheck(checks);
  await runAuditCheck(checks);

  const summary = {
    timestamp: new Date().toISOString(),
    strict,
    checks,
  };

  console.log(JSON.stringify(summary, null, 2));

  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  if (strict && (failed || warned)) {
    process.exit(1);
  }
}

await main();
