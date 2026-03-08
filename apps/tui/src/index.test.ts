/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { describe, expect, test } from "bun:test";
import { SERVER } from "./constants";
import { Pane, SessionMode } from "./types";

describe("tui config", () => {
  test("has server endpoint", () => {
    expect(SERVER.startsWith("http")).toBe(true);
  });

  test("exports pane and session modes", () => {
    expect(Pane.Chat).toBe("chat");
    expect(SessionMode.Local).toBe("local");
  });
});
