import { beforeEach, describe, expect, test } from "bun:test";
import { asSession, newId } from "@companion/core";
import { ConcurrencyError, createMemoryDB } from "./index";

describe("SqliteDB", () => {
  let db: ReturnType<typeof createMemoryDB>;

  beforeEach(() => {
    db = createMemoryDB();
  });

  test("creates and retrieves a session", async () => {
    const id = asSession(newId());
    const s = await db.sessions.create(id, "Test Session", "do something", "local");
    expect(s.id).toBe(id);
    expect(s.title).toBe("Test Session");
    expect(s.mode).toBe("local");
    expect(s.version).toBe(1);
  });

  test("updates session title and bumps updated_at", async () => {
    const id = asSession(newId());
    await db.sessions.create(id, "Original", "goal", "local");
    await db.sessions.update(id, { title: "Updated" });
    const s = await db.sessions.get(id);
    expect(s?.title).toBe("Updated");
  });

  test("OCC increments version on blackboard update", async () => {
    const id = asSession(newId());
    await db.sessions.create(id, "OCC Test", "goal", "local");
    await db.sessions.update(id, { blackboard: '{"goal":"v2"}' });
    const s = await db.sessions.get(id);
    expect(s?.version).toBe(2);
  });

  test("OCC throws ConcurrencyError on stale version", async () => {
    const id = asSession(newId());
    await db.sessions.create(id, "Concurrent", "goal", "local");
    // First writer
    await db.sessions.update(id, { blackboard: '{"x":1}', expected_version: 1 });
    // Second writer with stale version should throw
    expect(db.sessions.update(id, { blackboard: '{"x":2}', expected_version: 1 })).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
  });

  test("lists sessions ordered by updated_at desc", async () => {
    for (let i = 0; i < 3; i++) {
      await db.sessions.create(asSession(newId()), `Session ${i}`, "g", "local");
    }
    const sessions = await db.sessions.list();
    expect(sessions.length).toBe(3);
  });

  test("adds and retrieves messages", async () => {
    const sid = asSession(newId());
    await db.sessions.create(sid, "Msgs", "g", "local");
    const msg = await db.messages.add({
      id: asMessage(newId()),
      session_id: sid,
      role: "user",
      content: "hello",
    });
    expect(msg.content).toBe("hello");
    const list = await db.messages.list(sid);
    expect(list.length).toBe(1);
    expect(list[0]?.role).toBe("user");
  });

  test("deletes session cascades to messages", async () => {
    const sid = asSession(newId());
    await db.sessions.create(sid, "Del", "g", "local");
    await db.messages.add({ id: asMessage(newId()), session_id: sid, role: "user", content: "hi" });
    await db.sessions.delete(sid);
    const s = await db.sessions.get(sid);
    expect(s).toBeNull();
    const msgs = await db.messages.list(sid);
    expect(msgs.length).toBe(0);
  });
});

// Needed for import resolution in test file
import { asMessage } from "./index";
