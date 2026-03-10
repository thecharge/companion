/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { REQUEST_HEADERS, SERVER } from "../constants";
import { CompanionApiClient } from "../sdk/companion-api-client";
import { HttpClient } from "../sdk/http-client";
import { SessionRepository } from "../sdk/session-repository";

export interface TuiRuntime {
  apiClient: CompanionApiClient;
  sessionRepository: SessionRepository;
}

export const createTuiRuntime = (): TuiRuntime => {
  const httpClient = new HttpClient({
    baseUrl: SERVER,
    defaultHeaders: { ...REQUEST_HEADERS },
  });

  const apiClient = new CompanionApiClient(httpClient);
  const sessionRepository = new SessionRepository(apiClient);

  return { apiClient, sessionRepository };
};
