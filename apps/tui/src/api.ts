/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { REQUEST_HEADERS, SERVER } from "./constants";

export async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: REQUEST_HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}
