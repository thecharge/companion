import { describe, expect, test } from "bun:test";
import { Blackboard, newId, ok, err, asSession, asMessage } from "./index";

describe("newId", () => {
  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});

describe("Result", () => {
  test("ok wraps value", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  test("err wraps error", () => {
    const r = err(new Error("boom"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("boom");
  });
});

describe("Blackboard", () => {
  test("serialises and deserialises", () => {
    const bb = new Blackboard({ goal: "test goal" });
    bb.appendObservation("obs 1");
    bb.setArtifact("file.ts", "content");
    const json = bb.toJSON();
    const bb2  = Blackboard.fromJSON(json);
    expect(bb2.goal).toBe("test goal");
    expect(bb2.read("observations")).toEqual(["obs 1"]);
    expect(bb2.read("artifacts")).toMatchObject({ "file.ts": "content" });
  });

  test("summary never slices rejections", () => {
    const bb = new Blackboard({ goal: "refactor api" });
    for (let i = 0; i < 10; i++) {
      bb.appendRejection(i, "engineer", `failed attempt ${i}`);
    }
    const summary = bb.summary();
    // All 10 rejections must appear
    expect(summary).toContain("[R0]");
    expect(summary).toContain("[R9]");
    expect(summary).toContain("DEAD ENDS");
  });

  test("summary groups rejections by target", () => {
    const bb = new Blackboard({ goal: "test" });
    bb.appendRejection(1, "engineer", "syntax error");
    bb.appendRejection(2, "analyst", "no data");
    bb.appendRejection(3, "engineer", "timeout");
    const summary = bb.summary();
    expect(summary).toContain("engineer: [R1] syntax error | [R3] timeout");
    expect(summary).toContain("analyst: [R2] no data");
  });

  test("viewFor returns only requested keys", () => {
    const bb   = new Blackboard({ goal: "g" });
    const view = bb.viewFor(["goal", "observations"]);
    expect("goal"         in view).toBe(true);
    expect("observations" in view).toBe(true);
    expect("artifacts"    in view).toBe(false);
  });

  test("fromJSON handles invalid JSON gracefully", () => {
    const bb = Blackboard.fromJSON("not json at all {{{");
    expect(bb.goal).toBe("");
    expect(bb.read("observations")).toEqual([]);
  });
});

describe("Branded IDs", () => {
  test("asSession and asMessage round-trip", () => {
    const sid = asSession("abc-123");
    const mid = asMessage("def-456");
    expect(sid as string).toBe("abc-123");
    expect(mid as string).toBe("def-456");
  });
});
