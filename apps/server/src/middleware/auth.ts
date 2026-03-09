/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import type { Config } from "@companion/config";
import { HeaderName, RoutePath } from "../constants/http";

export const isPublicIntegrationWebhook = (req: Request): boolean => {
  if (req.method !== "POST") return false;
  const path = new URL(req.url).pathname;
  return path === RoutePath.SlackWebhook || path === RoutePath.TelegramWebhook;
};

export const isAuthorizedRequest = (req: Request, cfg: Config): boolean => {
  if (isPublicIntegrationWebhook(req)) {
    return true;
  }

  const configuredSecret = cfg.server.secret;
  if (!configuredSecret) {
    return true;
  }

  const authorizationHeader = req.headers.get(HeaderName.Authorization) ?? "";
  const apiKeyHeader = req.headers.get(HeaderName.ApiKey) ?? "";
  const bearerSecret = `Bearer ${configuredSecret}`;

  if (authorizationHeader === bearerSecret) {
    return true;
  }

  if (authorizationHeader === configuredSecret) {
    return true;
  }

  return apiKeyHeader === configuredSecret;
};
