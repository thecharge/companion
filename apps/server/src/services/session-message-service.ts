/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { SessionProcessor } from "@companion/agents";
import { type Config, type ConfigStore, resolveWorkingDirConfig } from "@companion/config";
import { Blackboard, EventType, Logger, type SessionId, bus } from "@companion/core";
import { ConcurrencyError, type DB } from "@companion/db";
import type { ChatMessage, OAIToolCall } from "@companion/llm";
import { createLLMClient } from "@companion/llm";
import type { MemoryService } from "@companion/memory";
import type { ToolRegistry } from "@companion/tools";
import { SessionChatRepository } from "./session-chat-repository";
import { selectSummaryModel } from "./session-summary-model-strategy";

const log = new Logger("server.session-service");

interface SessionMessageServiceParams {
  cfg: Config;
  rootConfigPath: string;
  configStore: ConfigStore;
  db: DB;
  memoryService: MemoryService;
  toolRegistry: ToolRegistry;
  embedClient: ReturnType<typeof createLLMClient>;
  embedAvailable: boolean;
}

export class SessionMessageService {
  private readonly chatRepository: SessionChatRepository;

  constructor(private readonly params: SessionMessageServiceParams) {
    this.chatRepository = new SessionChatRepository(params.db);
  }

  processMessage = async (
    sessionId: SessionId,
    session: Awaited<ReturnType<DB["sessions"]["get"]>>,
    content: string,
    workingDir: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!session) {
      return;
    }

    const baseSessionConfig = this.params.configStore.get(sessionId);
    const sessionConfig = await resolveWorkingDirConfig(baseSessionConfig, workingDir, this.params.rootConfigPath);
    const history = await this.chatRepository.listMessages(sessionId, sessionConfig.memory.context_window.max_messages);
    const blackboard = Blackboard.fromJSON(session.blackboard);

    const chatHistory: ChatMessage[] = history.map((message) => ({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls as OAIToolCall[] | undefined,
      tool_call_id: message.tool_call_id,
      name: message.name,
    }));

    const recallTextList = await this.recallMemoryText(sessionId, content, blackboard);
    const userMessageWithRecall = this.composeUserMessage(content, recallTextList);
    const processor = new SessionProcessor(
      sessionConfig,
      this.params.toolRegistry,
      this.params.memoryService,
      this.params.db,
    );

    try {
      const result = await processor.handleMessage({
        session_id: sessionId,
        blackboard,
        user_message: userMessageWithRecall,
        history: chatHistory,
        working_dir: workingDir,
        mode: session.mode,
        signal,
      });

      const assistantMessage = await this.chatRepository.addAssistantMessage(sessionId, result.reply);
      await this.chatRepository.incrementMessageCount(sessionId);

      await this.storeMemoryChunked(sessionId, content, { role: "user" }).catch((error) =>
        log.warn("Store user memory failed", error),
      );
      await this.storeMemoryChunked(sessionId, result.reply, { role: "assistant" }).catch((error) =>
        log.warn("Store assistant memory failed", error),
      );

      await this.persistBlackboardWithOptimisticLock(sessionId, session.version, result.blackboard.toJSON());
      bus.emit({ type: EventType.Message, session_id: sessionId, ts: new Date(), payload: assistantMessage });

      const shouldSummarise =
        session.message_count > 0 &&
        session.message_count % sessionConfig.memory.summarisation.trigger_at_messages === 0;
      if (shouldSummarise) {
        void this.maybeSummarise(sessionId, sessionConfig).catch((error) => log.warn("Summarise failed", error));
      }
    } catch (error) {
      log.error("processMessage failed", error);
      bus.emit({ type: EventType.Error, session_id: sessionId, ts: new Date(), payload: { error: String(error) } });
    }
  };

  private composeUserMessage = (content: string, recallTextList: string[]): string => {
    if (recallTextList.length === 0) {
      return content;
    }

    const formattedRecall = recallTextList.map((line, index) => `${index + 1}. ${line}`).join("\n");
    return `${content}\n\n[Relevant memories]\n${formattedRecall}`;
  };

  private recallMemoryText = async (
    sessionId: SessionId,
    content: string,
    blackboard: Blackboard,
  ): Promise<string[]> => {
    if (!this.params.embedAvailable) {
      return [];
    }

    try {
      const recallQuery = [content, blackboard.goal, blackboard.read("observations").slice(-1)[0] ?? ""]
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
      const queryEmbedding = await this.params.embedClient.embed(recallQuery);
      return await this.params.memoryService.recall(sessionId, queryEmbedding);
    } catch (error) {
      log.warn("Recall failed", error);
      return [];
    }
  };

  private storeMemoryChunked = async (
    sessionId: SessionId,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> => {
    if (!this.params.embedAvailable || !text.trim()) {
      return;
    }

    const chunks = this.params.memoryService.chunkText(text).slice(0, 8);
    for (const chunk of chunks) {
      const embedding = await this.params.embedClient.embed(chunk.content);
      const chunkId = `${Date.now().toString(36)}-${chunk.pageNum}`;
      await this.params.memoryService.store(sessionId, chunkId, chunk.content, embedding, {
        ...metadata,
        page: chunk.pageNum,
        total_pages: chunk.totalPages,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
      });
    }
  };

  private persistBlackboardWithOptimisticLock = async (
    sessionId: SessionId,
    expectedVersion: number,
    blackboardJson: string,
  ): Promise<void> => {
    try {
      await this.chatRepository.updateSessionBlackboard(sessionId, expectedVersion, blackboardJson);
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) {
        throw error;
      }

      log.warn(`OCC conflict on ${sessionId} - blackboard not saved`);
      bus.emit({
        type: EventType.Error,
        session_id: sessionId,
        ts: new Date(),
        payload: { error: error.message },
      });
    }
  };

  private maybeSummarise = async (sessionId: SessionId, cfg: Config): Promise<void> => {
    if (!cfg.memory.summarisation.enabled) {
      return;
    }

    const summaryModel = selectSummaryModel(cfg);
    if (!summaryModel) {
      return;
    }

    const messages = await this.params.db.messages.list(sessionId, { limit: 50 });
    const llm = createLLMClient(summaryModel);
    const response = await llm.chat({
      messages: [
        { role: "system", content: "Summarise this conversation in 2-3 sentences." },
        { role: "user", content: messages.map((m) => `${m.role}: ${m.content}`).join("\n") },
      ],
    });

    const summary = response.choices[0]?.message.content ?? "";
    if (!summary) {
      return;
    }

    await this.chatRepository.updateSessionSummary(sessionId, summary);
  };
}
