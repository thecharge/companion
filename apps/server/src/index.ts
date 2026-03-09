/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Logger } from "@companion/core";
import { createAppContext } from "./bootstrap/app-context";
import { createServerRuntime } from "./bootstrap/server-runtime";
import { createHttpRouter } from "./routes/http-router";

const log = new Logger("server");

const run = async (): Promise<void> => {
  const appContext = await createAppContext();
  const httpRouter = createHttpRouter(appContext);
  const serverRuntime = createServerRuntime(appContext, httpRouter);
  const startedServer = serverRuntime.start();

  log.info(`Server listening on ${appContext.cfg.server.host}:${startedServer.port}`);
  log.info(
    `DB: ${appContext.cfg.db.driver} | Tools: ${appContext.toolRegistry.list().length} | Skills: ${appContext.skills.length}`,
  );
};

await run();
