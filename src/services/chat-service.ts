import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { buildMemorySessionKey } from "../memory/build-memory-config.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient, ChatMessage } from "../openai/chat-client.ts";
import type { OffloadService } from "../offload/index.ts";
import { PromptBuilder } from "../prompt/prompt-builder.ts";
import type { ToolHandler } from "../tools/tool-handler.ts";

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
  private readonly histories = new Map<number, ChatMessage[]>();
  private readonly offloadPostTurnChains = new Map<string, Promise<void>>();
  private readonly MAX_HISTORY = 10;
  private readonly promptBuilder: PromptBuilder;
  private readonly toolHandler?: ToolHandler;
  private readonly offloadService?: OffloadService;

  constructor(private readonly opts: ChatServiceOptions) {
    this.promptBuilder = opts.promptBuilder ?? new PromptBuilder();
    this.toolHandler = opts.toolHandler;
    this.offloadService = opts.offloadService;
  }

  async replyToUser(params: { telegramUserId: number; text: string }): Promise<string> {
    const userKey = buildMemorySessionKey(params.telegramUserId);

    // ── 1. Memory recall (long-term context from TencentDB) ──
    let prependContext = "";
    let appendSystemContext = "";

    try {
      const recall = await this.opts.memory.recall(userKey, params.text);
      prependContext = recall.prependContext ?? "";
      appendSystemContext = recall.appendSystemContext ?? "";
    } catch (error) {
      this.opts.logger.warn(
        `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ── 2. Reset tool call counter for this turn ──
    this.toolHandler?.resetCallCount();

    // ── 3. Offload before-turn: compress conversation history ──
    const history = this.histories.get(params.telegramUserId) ?? [];
    const offloadMessages: ChatMessage[] = this.offloadService
      ? (await this.offloadService.beforeTurn({
          userKey,
          userText: params.text,
          previousMessages: history,
        })) as ChatMessage[]
      : history;

    // ── 4. Build LLM request using PromptBuilder ──
    const prompt = this.promptBuilder.build({
      prependContext,
      appendSystemContext,
      userText: params.text,
      previousMessages: offloadMessages,
    });

    const offloadToolTasks: Promise<void>[] = [];
    const reply = await this.opts.chatClient.reply({
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
    });

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

    // ── 6. Post-turn work runs outside the reply path ──
    if (this.offloadService) {
      const offloadService = this.offloadService;
      this.runOffloadPostTurn(userKey, async () => {
        await Promise.allSettled(offloadToolTasks);
        await offloadService.afterTurn({ userKey, userText: params.text });
      });
    }

    this.runInBackground("Memory capture", async () => {
      await this.opts.memory.capture(userKey, params.text, reply);
    });

    return reply;
  }

  private runOffloadPostTurn(userKey: string, task: () => Promise<void>): void {
    setTimeout(() => {
      const previous = this.offloadPostTurnChains.get(userKey) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(task)
        .catch((error: unknown) => {
          this.opts.logger.warn(`[offload] afterTurn failed: ${this.formatError(error)}`);
        })
        .finally(() => {
          if (this.offloadPostTurnChains.get(userKey) === next) {
            this.offloadPostTurnChains.delete(userKey);
          }
        });

      this.offloadPostTurnChains.set(userKey, next);
    }, 0);
  }

  private runInBackground(label: string, task: () => Promise<void>): void {
    setTimeout(() => {
      void task().catch((error: unknown) => {
        this.opts.logger.warn(`${label} failed: ${this.formatError(error)}`);
      });
    }, 0);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
