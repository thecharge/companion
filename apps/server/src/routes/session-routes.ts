/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import {
  EventType,
  Logger,
  MessageRole,
  type SessionId,
  type SessionMode,
  type SessionStatus,
  asMessage,
  asSession,
  bus,
  newId,
} from "@companion/core";
import type { AppContext } from "../bootstrap/app-context";
import {
  HeaderName,
  HeaderValue,
  HttpMethod,
  HttpStatus,
  QueryParam,
  ResponseError,
  RoutePath,
} from "../constants/http";
import { badRequestResponse, errorResponse, invalidBodyResponse, notFoundResponse } from "../middleware/http-responses";
import type { AuditLogService } from "../services/audit-log-service";
import type { SessionMessageService } from "../services/session-message-service";

const log = new Logger("server.session-routes");

interface SessionPostBody {
  title?: string;
  goal?: string;
  mode?: string;
}

interface MessagePostBody {
  content?: string;
  stream?: boolean;
  working_dir?: string;
}

const parseJsonBody = async <T>(req: Request): Promise<T | null> => {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
};

const parseSessionPath = (pathName: string): { sessionId: SessionId; subPath: string } | null => {
  const match = pathName.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  if (!match || !match[1]) {
    return null;
  }

  return { sessionId: asSession(match[1]), subPath: match[2] ?? "" };
};

const createSseResponse = (
  sessionId: SessionId,
  sessionMessageService: SessionMessageService,
  ctx: AppContext,
  session: Awaited<ReturnType<AppContext["db"]["sessions"]["get"]>>,
  content: string,
  workingDir: string,
): Response => {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });

  const send = (data: unknown): void => {
    try {
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      // Stream is closed by consumer.
    }
  };

  const unsubscribe = bus.on("*", (event) => {
    if (event.session_id !== sessionId) return;
    if (event.type === EventType.Message) {
      const payload = event.payload as { content: string };
      send({ type: "text", text: payload.content });
      try {
        streamController.close();
      } catch {
        // Stream already closed.
      }
      unsubscribe();
      return;
    }

    if (event.type === EventType.AgentThought) send({ type: "thought", ...(event.payload as object) });
    if (event.type === EventType.ToolStart) send({ type: "tool_start", ...(event.payload as object) });
    if (event.type === EventType.ToolEnd) send({ type: "tool_end", ...(event.payload as object) });
    if (event.type === EventType.Error) send({ type: "error", ...(event.payload as object) });
  });

  const abortController = new AbortController();
  ctx.activeCancels.set(sessionId, abortController);
  void sessionMessageService
    .processMessage(sessionId, session, content, workingDir, abortController.signal)
    .catch((error) => {
      send({ type: "error", error: String(error) });
      try {
        streamController.close();
      } catch {
        // Stream already closed.
      }
      unsubscribe();
    })
    .finally(() => {
      ctx.activeCancels.delete(sessionId);
    });

  return new Response(stream, {
    headers: {
      [HeaderName.ContentType]: HeaderValue.EventStream,
      [HeaderName.CacheControl]: HeaderValue.NoCache,
      [HeaderName.Connection]: HeaderValue.KeepAlive,
    },
  });
};

export const handleSessionRoutes = async (
  req: Request,
  ctx: AppContext,
  sessionMessageService: SessionMessageService,
  auditLogService: AuditLogService,
): Promise<Response | null> => {
  const url = new URL(req.url);
  const pathName = url.pathname;
  const method = req.method;

  if (pathName === RoutePath.Sessions && method === HttpMethod.Get) {
    const sessions = await ctx.db.sessions.list();
    await auditLogService.recordHttpEvent({ action: "sessions_list", status: "ok", request: req });
    return Response.json({ sessions });
  }

  if (pathName === RoutePath.Sessions && method === HttpMethod.Post) {
    const body = await parseJsonBody<SessionPostBody>(req);
    if (!body) return invalidBodyResponse();

    const sessionId = asSession(newId());
    const title = body.title ?? "New Session";
    const goal = body.goal ?? title;
    const mode = (body.mode ?? ctx.cfg.mode.default) as SessionMode;
    const session = await ctx.db.sessions.create(sessionId, title, goal, mode);
    await auditLogService.recordHttpEvent({ action: "session_create", status: "ok", request: req, sessionId });
    return Response.json({ session }, { status: HttpStatus.Created });
  }

  const parsedSessionPath = parseSessionPath(pathName);
  if (!parsedSessionPath) return null;

  const { sessionId, subPath } = parsedSessionPath;
  const session = await ctx.db.sessions.get(sessionId);
  if (!session && subPath !== "") return notFoundResponse();

  if (subPath === "" && method === HttpMethod.Get) {
    await auditLogService.recordHttpEvent({ action: "session_get", status: "ok", request: req, sessionId });
    return Response.json({ session });
  }

  if (subPath === "" && method === HttpMethod.Patch) {
    if (!session) return notFoundResponse();
    const body = await parseJsonBody<Record<string, unknown>>(req);
    if (!body) return invalidBodyResponse();

    await ctx.db.sessions.update(sessionId, {
      title: body.title as string | undefined,
      mode: body.mode as SessionMode | undefined,
      status: body.status as SessionStatus | undefined,
    });
    await auditLogService.recordHttpEvent({ action: "session_patch", status: "ok", request: req, sessionId });
    return Response.json({ ok: true });
  }

  if (subPath === "" && method === HttpMethod.Delete) {
    await ctx.db.sessions.delete(sessionId);
    await auditLogService.recordHttpEvent({ action: "session_delete", status: "ok", request: req, sessionId });
    return Response.json({ ok: true });
  }

  if (subPath === RoutePath.SessionMessagesSuffix && method === HttpMethod.Get) {
    const limit = Number(url.searchParams.get(QueryParam.Limit) ?? "100");
    const messages = await ctx.db.messages.list(sessionId, { limit });
    await auditLogService.recordHttpEvent({ action: "session_messages_list", status: "ok", request: req, sessionId });
    return Response.json({ messages });
  }

  if (subPath === RoutePath.SessionMessagesSuffix && method === HttpMethod.Post) {
    if (!session) return notFoundResponse();

    if (ctx.activeCancels.has(sessionId)) {
      log.warn(`Rejecting message: session busy (${sessionId})`);
      await auditLogService.recordHttpEvent({
        action: "session_message_rejected_busy",
        status: "error",
        request: req,
        sessionId,
      });
      return errorResponse(ResponseError.SessionBusy, HttpStatus.TooManyRequests);
    }

    const body = await parseJsonBody<MessagePostBody>(req);
    if (!body) return invalidBodyResponse();

    const content = body.content?.trim();
    if (!content) return badRequestResponse(ResponseError.ContentRequired);

    const workingDir = body.working_dir ?? process.cwd();
    log.info(`Accepted message for session ${sessionId}`, {
      stream: Boolean(body.stream),
      working_dir: workingDir,
      content_preview: content.slice(0, 80),
    });
    const userMessage = await ctx.db.messages.add({
      id: asMessage(newId()),
      session_id: sessionId,
      role: MessageRole.User,
      content,
    });
    await ctx.db.sessions.incrementMessageCount(sessionId);
    await auditLogService.recordHttpEvent({ action: "session_message_create", status: "ok", request: req, sessionId });

    if (body.stream) return createSseResponse(sessionId, sessionMessageService, ctx, session, content, workingDir);

    const abortController = new AbortController();
    ctx.activeCancels.set(sessionId, abortController);
    void sessionMessageService
      .processMessage(sessionId, session, content, workingDir, abortController.signal)
      .finally(() => ctx.activeCancels.delete(sessionId));

    return Response.json({ message: userMessage }, { status: HttpStatus.Accepted });
  }

  if (subPath === RoutePath.SessionBlackboardSuffix && method === HttpMethod.Get) {
    if (!session) return notFoundResponse();
    await auditLogService.recordHttpEvent({ action: "session_blackboard_get", status: "ok", request: req, sessionId });
    return Response.json({ blackboard: JSON.parse(session.blackboard) });
  }

  return notFoundResponse();
};
