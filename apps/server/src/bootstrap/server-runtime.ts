/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Logger } from "@companion/core";
import { HeaderName, HeaderValue, HttpStatus, QueryParam } from "../constants/http";
import { isAuthorizedRequest } from "../middleware/auth";
import { unauthorizedResponse } from "../middleware/http-responses";
import { withSecurityHeaders } from "../security";
import { SessionWebSocketHub } from "../ws/session-websocket-hub";
import type { AppContext } from "./app-context";

const log = new Logger("server");

type ServerWebSocket = import("bun").ServerWebSocket<{ session_id: string }>;

export const createServerRuntime = (
  ctx: AppContext,
  handleHttpRequest: (req: Request) => Promise<Response>,
): { start: () => { server: import("bun").Server; port: number } } => {
  const websocketHub = new SessionWebSocketHub(ctx.activeCancels);

  const serverOptions = {
    hostname: ctx.cfg.server.host,
    idleTimeout: 0,
    fetch: (req: Request, server: import("bun").Server) => {
      if (!isAuthorizedRequest(req, ctx.cfg)) {
        return withSecurityHeaders(unauthorizedResponse());
      }

      const upgrade = req.headers.get(HeaderName.Upgrade);
      if (upgrade === HeaderValue.WebSocket) {
        const url = new URL(req.url);
        const token = url.searchParams.get(QueryParam.Token) ?? "";
        const sessionId = url.searchParams.get(QueryParam.Session) ?? "";
        const secret = ctx.cfg.server.secret;

        if (secret && token !== secret) {
          return withSecurityHeaders(unauthorizedResponse());
        }

        const upgraded = server.upgrade(req, { data: { session_id: sessionId } });
        if (!upgraded) {
          return withSecurityHeaders(new Response("WS upgrade failed", { status: HttpStatus.InternalServerError }));
        }

        return undefined;
      }

      return handleHttpRequest(req).then(withSecurityHeaders);
    },
    websocket: {
      open: (ws: ServerWebSocket) => {
        if (!ws.data.session_id) {
          return;
        }

        websocketHub.subscribeClient(ws, ws.data.session_id);
        ws.send(websocketHub.createConnectedPayload(ws.data.session_id));
        ws.send(websocketHub.createSyncStatePayload(ws.data.session_id));
      },
      message: (ws: ServerWebSocket, message: string | Buffer) => {
        websocketHub.handleInboundMessage(ws, message);
      },
      close: (ws: ServerWebSocket) => {
        websocketHub.unsubscribeClient(ws);
      },
    },
  } satisfies Parameters<typeof Bun.serve<{ session_id: string }>>[0];

  const startWithFallback = (): { server: import("bun").Server; port: number } => {
    const preferredPort = ctx.cfg.server.port;
    const maxAttempts = 20;

    for (let offset = 0; offset < maxAttempts; offset++) {
      const port = preferredPort + offset;
      try {
        const server = Bun.serve<{ session_id: string }>({ ...serverOptions, port });
        if (offset > 0) {
          log.warn(`Port ${preferredPort} in use; started on ${port} instead.`);
        }
        return { server, port };
      } catch (error) {
        const errorCode = (error as { code?: string }).code;
        if (errorCode === "EADDRINUSE") {
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Unable to bind server. Ports ${preferredPort}-${preferredPort + maxAttempts - 1} are in use.`);
  };

  return { start: startWithFallback };
};
