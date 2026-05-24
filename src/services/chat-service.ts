import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { buildMemorySessionKey } from "../memory/build-memory-config.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient, ChatMessage } from "../openai/chat-client.ts";
import type { OffloadService } from "../offload/index.ts";
import { PromptBuilder } from "../prompt/prompt-builder.ts";
import type { ToolHandler } from "../tools/tool-handler.ts";
import { isTokenOverflowError } from "../offload/compressor.ts";

export interface ChatServiceOptions {
  memory: MemoryAdapter;
  chatClient: ChatClient;
  logger: Logger;
  /** Custom prompt builder for assembling LLM requests. */
  promptBuilder?: PromptBuilder;
  /**
   * Optional tool handler for memory search tools (tdai_memory_search,
   * tdai_conversation_search). When provided, the LLM can proactively
   * search memories and conversations during a turn.
   */
  toolHandler?: ToolHandler;
  /**
   * Optional offload service for context compression and L1 summarization.
   * When provided, beforeTurn()/onToolCall()/afterTurn() lifecycle hooks
   * are called during replyToUser().
   */
  offloadService?: OffloadService;
}

export class ChatService {
  /** Max users tracked in memory before LRU eviction. Prevents unbounded Map growth. */
  private static readonly MAX_TRACKED_USERS = 500;

  /** Ordered list of user IDs for LRU eviction (most recently used at the end). */
  private readonly userAccessOrder: number[] = [];
  private readonly histories = new Map<number, ChatMessage[]>();
  private readonly MAX_HISTORY = 20;
  private readonly promptBuilder: PromptBuilder;
  private readonly toolHandler?: ToolHandler;
  private readonly offloadService?: OffloadService;

  constructor(private readonly opts: ChatServiceOptions) {
    this.promptBuilder = opts.promptBuilder ?? new PromptBuilder();
    this.toolHandler = opts.toolHandler;
    this.offloadService = opts.offloadService;
  }

  /**
   * Get or create history for a user, tracking LRU access.
   * Evicts the least recently used user when over MAX_TRACKED_USERS.
   */
  private getOrCreateHistory(telegramUserId: number): ChatMessage[] {
    // Update LRU order
    const idx = this.userAccessOrder.indexOf(telegramUserId);
    if (idx !== -1) {
      this.userAccessOrder.splice(idx, 1);
    }
    this.userAccessOrder.push(telegramUserId);

    // Evict oldest if over limit
    if (this.userAccessOrder.length > ChatService.MAX_TRACKED_USERS) {
      const evictedId = this.userAccessOrder.shift();
      if (evictedId !== undefined) {
        this.histories.delete(evictedId);
      }
    }

    let history = this.histories.get(telegramUserId);
    if (!history) {
      history = [];
      this.histories.set(telegramUserId, history);
    }
    return history;
  }

  async replyToUser(params: { telegramUserId: number; text: string }): Promise<string> {
    const startedAt = Date.now();
    const userKey = buildMemorySessionKey(params.telegramUserId);

    // ── 1. Memory recall (long-term context from TencentDB) ──
    let prependContext = "";
    let appendSystemContext = "";

    const recallStartedAt = Date.now();
    try {
      const recall = await this.opts.memory.recall(userKey, params.text);
      prependContext = recall.prependContext ?? "";
      appendSystemContext = recall.appendSystemContext ?? "";
      this.opts.logger.info(`[timing] recall: ${Date.now() - recallStartedAt}ms`);
    } catch (error) {
      this.opts.logger.warn(
        `Memory recall failed (${Date.now() - recallStartedAt}ms): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ── 2. Reset tool call counter for this turn ──
    this.toolHandler?.resetCallCount();

    // ── 3. Offload before-turn: compress conversation history ──
    const history = this.getOrCreateHistory(params.telegramUserId);
    const offloadStartedAt = Date.now();
    const offloadMessages: ChatMessage[] = this.offloadService
      ? (await this.offloadService.beforeTurn({
          userKey,
          userText: params.text,
          previousMessages: history,
        })) as ChatMessage[]
      : history;
    if (this.offloadService) {
      this.opts.logger.info(`[timing] offload.beforeTurn: ${Date.now() - offloadStartedAt}ms`);
    }

    // ── 4. Build LLM request using PromptBuilder ──
    const promptStartAt = Date.now();
    const prompt = this.promptBuilder.build({
      prependContext,
      appendSystemContext,
      userText: params.text,
      previousMessages: offloadMessages,
    });
    this.opts.logger.debug?.(
      `[timing] prompt.build: ${Date.now() - promptStartAt}ms`,
    );

    const offloadToolTasks: Promise<void>[] = [];
    const llmStartedAt = Date.now();
    let reply: string;
    try {
      reply = await this.opts.chatClient.reply({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        previousMessages: prompt.previousMessages,
        tools: this.toolHandler?.toolDefinitions,
        executeTool: this.toolHandler
          ? (name, args) => this.toolHandler!.executeTool(name, args)
          : undefined,
        onToolCallResult: this.offloadService
          ? (tc) => {
              const task = this.offloadService!.onToolCall({
                userKey,
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                params: tc.params,
                result: tc.result,
              }).catch((err: unknown) =>
                this.opts.logger.warn(`[offload] onToolCall error: ${this.formatError(err)}`),
              );
              offloadToolTasks.push(task);
              void task;
            }
          : undefined,
        onStepFinish: this.offloadService
          ? async (messages) => {
              try {
                await this.offloadService!.onStepFinish(messages, userKey);
              } catch (err: unknown) {
                this.opts.logger.warn(`[offload] onStepFinish error: ${this.formatError(err)}`);
              }
            }
          : undefined,
      });
      this.opts.logger.info(`[timing] llm.reply: ${Date.now() - llmStartedAt}ms`);
    } catch (error) {
      // ── Token overflow recovery: report to offload service ──
      const errorStr = this.formatError(error);
      this.opts.logger.info(`[timing] llm.reply FAILED: ${Date.now() - llmStartedAt}ms`);
      if (isTokenOverflowError(error)) {
        this.opts.logger.warn(
          `[chat] Token overflow detected: ${errorStr} — reporting to offload service`,
        );
        if (this.offloadService) {
          // Fire-and-forget: set force-emergency flag so next turn compresses harder
          this.offloadService.reportTokenOverflow(userKey).catch((err: unknown) =>
            this.opts.logger.warn(`[offload] reportTokenOverflow failed: ${this.formatError(err)}`),
          );
        }
      }
      // Re-throw so the caller can handle the error (e.g. send error reply to user)
      throw error;
    }

    // ── 5. Update conversation history ──
    const updatedHistory = [
      ...history,
      { role: "user" as const, content: params.text },
      { role: "assistant" as const, content: reply },
    ];

    if (updatedHistory.length > this.MAX_HISTORY * 2) {
      const trimmed = updatedHistory.slice(-this.MAX_HISTORY * 2);
      this.histories.set(params.telegramUserId, trimmed);
    } else {
      this.histories.set(params.telegramUserId, updatedHistory);
    }

    // ── 6. Post-turn work: offload afterTurn + memory capture ──
    if (this.offloadService) {
      const afterTurnStartedAt = Date.now();
      await Promise.allSettled(offloadToolTasks);
      try {
        await this.offloadService.afterTurn({ userKey, userText: params.text });
      } catch (err) {
        this.opts.logger.warn(`[offload] afterTurn failed: ${this.formatError(err)}`);
      }
      this.opts.logger.info(`[timing] offload.afterTurn: ${Date.now() - afterTurnStartedAt}ms`);
    }

    const captureStartedAt = Date.now();
    try {
      await this.opts.memory.capture(userKey, params.text, reply);
    } catch (err) {
      this.opts.logger.warn(`Memory capture failed: ${this.formatError(err)}`);
    }
    this.opts.logger.info(`[timing] memory.capture: ${Date.now() - captureStartedAt}ms`);

    this.opts.logger.info(`[timing] replyToUser total: ${Date.now() - startedAt}ms (user=${params.telegramUserId})`);
    return reply;
  }
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
