/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

export interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders: Record<string, string>;
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  getBaseUrl = (): string => this.options.baseUrl;

  getDefaultHeaders = (): Record<string, string> => this.options.defaultHeaders;

  request = async <TResponse>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<TResponse> => {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: this.options.defaultHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${path}`);
    }

    return (await response.json()) as TResponse;
  };
}
