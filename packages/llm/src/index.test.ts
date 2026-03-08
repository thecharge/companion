/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { modelSupportsTools, stripThinking } from "./index";

describe("llm helpers", () => {
  test("strips qwen thinking tags", () => {
    const input = "<think>internal</think>answer";
    const out = stripThinking(input);
    expect(out.thinking).toBe("internal");
    expect(out.text).toBe("answer");
  });

  test("marks known non-tool models", () => {
    expect(modelSupportsTools("qwen3:1.7b")).toBe(false);
    expect(modelSupportsTools("qwen3:4b")).toBe(true);
  });
});
