import { describe, expect, test } from "bun:test";
import type { IdGenerationStrategy } from "./id-generation-strategy";
import { newId, setIdGenerationStrategy } from "./index";

class FixedIdStrategy implements IdGenerationStrategy {
  next(sequence: number): string {
    return `fixed-${sequence}`;
  }
}

describe("id generation strategy", () => {
  test("allows overriding ID generation strategy", () => {
    setIdGenerationStrategy(new FixedIdStrategy());
    const id = newId();
    expect(id.startsWith("fixed-")).toBe(true);
  });
});
