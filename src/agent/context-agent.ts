import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient, ChatMessage } from "../openai/chat-client.ts";
import { isTokenOverflowError } from "../offload/compressor.ts";
import type { OffloadService } from "../offload/index.ts";
import { PromptBuilder } from "../prompt/prompt-builder.ts";
import type { ToolHandler } from "../tools/tool-handler.ts";

export interface ContextAgentOptions {
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
   * are called during reply().
   */
  offloadService?: OffloadService;
}

export interface ContextAgentReplyParams {
  telegramUserId: number;
  userKey: string;
  text: string;
  history: ChatMessage[];
}

export interface ContextAgentReplyResult {
  reply: string;
  updateHistory: boolean;
}

/**
 * Owns the per-turn context pipeline for the chat agent.
 *
 * ChatService handles user history storage; ContextAgent handles all context
 * assembly and side effects around a single LLM turn.
 */
export class ContextAgent {
  private readonly promptBuilder: PromptBuilder;
  private readonly toolHandler?: ToolHandler;
  private readonly offloadService?: OffloadService;

  constructor(private readonly opts: ContextAgentOptions) {
    this.promptBuilder = opts.promptBuilder ?? new PromptBuilder();
    this.toolHandler = opts.toolHandler;
    this.offloadService = opts.offloadService;
  }

  async reply(params: ContextAgentReplyParams): Promise<ContextAgentReplyResult> {
    const startedAt = Date.now();
    const { telegramUserId, userKey, text, history } = params;

    const l4Result = await this.tryCreateSkill(userKey, text);
    if (l4Result) {
      this.opts.logger.info(
        `[timing] replyToUser L4 command total: ${Date.now() - startedAt}ms (user=${telegramUserId})`,
      );
      return { reply: l4Result, updateHistory: false };
    }

    const recall = await this.recall(userKey, text);
    this.toolHandler?.resetCallCount(userKey);

    const previousMessages = await this.prepareOffloadMessages(userKey, text, history);
    const promptStartAt = Date.now();
    const prompt = this.promptBuilder.build({
      prependContext: recall.prependContext,
      appendSystemContext: recall.appendSystemContext,
      userText: text,
      previousMessages,
    });
    this.opts.logger.debug?.(`[timing] prompt.build: ${Date.now() - promptStartAt}ms`);

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
          ? (name, args) => this.toolHandler!.executeTool(name, args, userKey)
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
      await this.handleFailedReply(error, {
        userKey,
        userText: text,
        llmStartedAt,
        offloadToolTasks,
      });
      throw error;
    }

    await this.runOffloadAfterTurn(userKey, text, offloadToolTasks, false);
    await this.capture(userKey, text, reply);

    this.opts.logger.info(
      `[timing] replyToUser total: ${Date.now() - startedAt}ms (user=${telegramUserId})`,
    );
    return { reply, updateHistory: true };
  }

  private async tryCreateSkill(userKey: string, text: string): Promise<string | null> {
    const createSkill = this.offloadService?.createSkillFromCommand;
    if (typeof createSkill !== "function") return null;
    return await createSkill.call(this.offloadService, userKey, text);
  }

  private async recall(
    userKey: string,
    text: string,
  ): Promise<{ prependContext: string; appendSystemContext: string }> {
    const recallStartedAt = Date.now();
    try {
      const recall = await this.opts.memory.recall(userKey, text);
      this.opts.logger.info(`[timing] recall: ${Date.now() - recallStartedAt}ms`);
      return {
        prependContext: recall.prependContext ?? "",
        appendSystemContext: recall.appendSystemContext ?? "",
      };
    } catch (error) {
      this.opts.logger.warn(
        `Memory recall failed (${Date.now() - recallStartedAt}ms): ${this.formatError(error)}`,
      );
      return { prependContext: "", appendSystemContext: "" };
    }
  }

  private async prepareOffloadMessages(
    userKey: string,
    userText: string,
    history: ChatMessage[],
  ): Promise<ChatMessage[]> {
    if (!this.offloadService) return history;

    const offloadStartedAt = Date.now();
    const messages = await this.offloadService.beforeTurn({
      userKey,
      userText,
      previousMessages: history,
    });
    this.opts.logger.info(`[timing] offload.beforeTurn: ${Date.now() - offloadStartedAt}ms`);
    return messages as ChatMessage[];
  }

  private async handleFailedReply(
    error: unknown,
    params: {
      userKey: string;
      userText: string;
      llmStartedAt: number;
      offloadToolTasks: Promise<void>[];
    },
  ): Promise<void> {
    const errorStr = this.formatError(error);
    this.opts.logger.info(`[timing] llm.reply FAILED: ${Date.now() - params.llmStartedAt}ms`);

    if (isTokenOverflowError(error)) {
      this.opts.logger.warn(
        `[chat] Token overflow detected: ${errorStr} - reporting to offload service`,
      );
      this.offloadService?.reportTokenOverflow(params.userKey).catch((err: unknown) =>
        this.opts.logger.warn(`[offload] reportTokenOverflow failed: ${this.formatError(err)}`),
      );
    }

    if (params.offloadToolTasks.length > 0) {
      await this.runOffloadAfterTurn(
        params.userKey,
        params.userText,
        params.offloadToolTasks,
        true,
      );
    }
  }

  private async runOffloadAfterTurn(
    userKey: string,
    userText: string,
    offloadToolTasks: Promise<void>[],
    afterFailedReply: boolean,
  ): Promise<void> {
    if (!this.offloadService) return;

    const afterTurnStartedAt = Date.now();
    await Promise.allSettled(offloadToolTasks);
    try {
      await this.offloadService.afterTurn({ userKey, userText });
    } catch (err) {
      const label = afterFailedReply ? "afterTurn after failed reply" : "afterTurn";
      this.opts.logger.warn(`[offload] ${label} failed: ${this.formatError(err)}`);
    }

    const timingLabel = afterFailedReply
      ? "offload.afterTurn after failed reply"
      : "offload.afterTurn";
    this.opts.logger.info(`[timing] ${timingLabel}: ${Date.now() - afterTurnStartedAt}ms`);
  }

  private async capture(userKey: string, text: string, reply: string): Promise<void> {
    const captureStartedAt = Date.now();
    try {
      await this.opts.memory.capture(userKey, text, reply);
    } catch (err) {
      this.opts.logger.warn(`Memory capture failed: ${this.formatError(err)}`);
    }
    this.opts.logger.info(`[timing] memory.capture: ${Date.now() - captureStartedAt}ms`);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
