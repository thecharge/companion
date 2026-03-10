/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { HttpStatus, ResponseError } from "../constants/http";

export const unauthorizedResponse = (): Response =>
  Response.json({ error: ResponseError.Unauthorized }, { status: HttpStatus.Unauthorized });

export const notFoundResponse = (): Response =>
  Response.json({ error: ResponseError.NotFound }, { status: HttpStatus.NotFound });

export const badRequestResponse = (message: string): Response =>
  Response.json({ error: message }, { status: HttpStatus.BadRequest });

export const invalidBodyResponse = (): Response => badRequestResponse(ResponseError.InvalidRequestBody);

export const errorResponse = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });
