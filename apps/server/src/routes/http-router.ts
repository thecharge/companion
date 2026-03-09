/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { SessionStatus } from "@companion/core";
import { HttpMethod, QueryParam, RoutePath } from "../constants/http";
import { notFoundResponse } from "../middleware/http-responses";
import type { AppContext } from "../bootstrap/app-context";
import { SessionMessageService } from "../services/session-message-service";
import { handleSessionRoutes } from "./session-routes";

const buildMetricsResponse = async (ctx: AppContext): Promise<Response> => {
  const activeSessions = await ctx.db.sessions.list({ status: SessionStatus.Active, limit: 10_000 });
  return Response.json({
    ok: true,
    active_sessions: activeSessions.length,
    registered_tools: ctx.toolRegistry.list().length,
    loaded_skills: ctx.skills.length,
    embed_ready: ctx.embedAvailable,
    timestamp: new Date().toISOString(),
  });
};

const buildCapabilitiesResponse = (ctx: AppContext): Response => {
  const agents = Object.entries(ctx.cfg.agents).map(([name, agent]) => ({
    name,
    description: agent.description,
    model: agent.model,
  }));

  const tools = ctx.toolRegistry
    .list()
    .map((tool) => ({ name: tool.function.name, description: tool.function.description, source: "built-in" }));

  const skills = ctx.skills.map((skill) => ({ name: skill.name, description: skill.description }));
  return Response.json({ agents, tools, skills, mode: ctx.cfg.mode.default });
};

export const createHttpRouter = (ctx: AppContext): ((req: Request) => Promise<Response>) => {
  const sessionMessageService = new SessionMessageService({
    cfg: ctx.cfg,
    configStore: ctx.configStore,
    db: ctx.db,
    memoryService: ctx.memoryService,
    toolRegistry: ctx.toolRegistry,
    embedClient: ctx.embedClient,
    embedAvailable: ctx.embedAvailable,
  });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathName = url.pathname;
    const method = req.method;

    if (pathName === RoutePath.Health && method === HttpMethod.Get) {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }

    if (pathName === RoutePath.Metrics && method === HttpMethod.Get) {
      return buildMetricsResponse(ctx);
    }

    if (pathName === RoutePath.AuditEvents && method === HttpMethod.Get) {
      const limit = Number(url.searchParams.get(QueryParam.AuditLimit) ?? "200");
      await ctx.auditLogService.recordHttpEvent({ action: "audit_events_list", status: "ok" });
      const events = await ctx.auditLogService.listRecent(limit);
      return Response.json({ events });
    }

    if (pathName === RoutePath.Capabilities && method === HttpMethod.Get) {
      return buildCapabilitiesResponse(ctx);
    }

    const sessionRouteResponse = await handleSessionRoutes(req, ctx, sessionMessageService, ctx.auditLogService);
    if (sessionRouteResponse) {
      return sessionRouteResponse;
    }

    return notFoundResponse();
  };
};
