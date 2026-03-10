/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

export const HttpMethod = {
  Get: "GET",
  Post: "POST",
  Patch: "PATCH",
  Delete: "DELETE",
} as const;

export const HttpStatus = {
  Ok: 200,
  Created: 201,
  Accepted: 202,
  TooManyRequests: 429,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  InternalServerError: 500,
} as const;

export const RoutePath = {
  Health: "/health",
  Metrics: "/metrics",
  AuditEvents: "/audit/events",
  Capabilities: "/capabilities",
  SlackWebhook: "/integrations/slack/events",
  TelegramWebhook: "/integrations/telegram/webhook",
  IntegrationsTelemetryConfig: "/integrations/telemetry/config",
  IntegrationsTelemetryStats: "/integrations/telemetry/stats",
  Sessions: "/sessions",
  SessionMessagesSuffix: "/messages",
  SessionBlackboardSuffix: "/blackboard",
} as const;

export const HeaderName = {
  Authorization: "Authorization",
  ApiKey: "x-api-key",
  Upgrade: "Upgrade",
  ContentType: "Content-Type",
  CacheControl: "Cache-Control",
  Connection: "Connection",
} as const;

export const HeaderValue = {
  WebSocket: "websocket",
  EventStream: "text/event-stream",
  NoCache: "no-cache",
  KeepAlive: "keep-alive",
} as const;

export const QueryParam = {
  Limit: "limit",
  AuditLimit: "limit",
  Session: "session",
  Token: "token",
} as const;

export const ResponseError = {
  Unauthorized: "Unauthorized",
  NotFound: "Not found",
  ContentRequired: "content is required",
  SessionBusy: "session is busy processing another message",
  InvalidRequestBody: "Invalid request body",
} as const;
