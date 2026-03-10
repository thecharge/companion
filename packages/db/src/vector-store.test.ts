import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "./vector-store";

describe("sqlite vector store", () => {
  test("upsert and search by cosine score", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-vec-"));
    const dbPath = join(dir, "vec.db");
    const store = new SqliteVectorStore(dbPath);

    await store.upsert({
      id: "a",
      session_id: "s1",
      content: "alpha",
      embedding: [1, 0, 0],
    });
    await store.upsert({
      id: "b",
      session_id: "s1",
      content: "beta",
      embedding: [0, 1, 0],
    });

    const rows = await store.search("s1", [1, 0, 0], 2, 0.1);
    expect(rows[0]?.id).toBe("a");

    await rm(dir, { recursive: true, force: true });
  });
});
