import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { buildMemorySessionKey } from "../memory/build-memory-config.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient, ChatMessage } from "../openai/chat-client.ts";
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
}

export class ChatService {
  private readonly histories = new Map<number, ChatMessage[]>();
  private readonly MAX_HISTORY = 10;
  private readonly promptBuilder: PromptBuilder;
  private readonly toolHandler?: ToolHandler;

  constructor(private readonly opts: ChatServiceOptions) {
    this.promptBuilder = opts.promptBuilder ?? new PromptBuilder();
    this.toolHandler = opts.toolHandler;
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

    // ── 3. Build LLM request using PromptBuilder ──
    const history = this.histories.get(params.telegramUserId) ?? [];
    const prompt = this.promptBuilder.build({
      prependContext,
      appendSystemContext,
      userText: params.text,
      previousMessages: history,
    });

    const reply = await this.opts.chatClient.reply({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      previousMessages: prompt.previousMessages,
      tools: this.toolHandler?.toolDefinitions,
      executeTool: this.toolHandler
        ? (name, args) => this.toolHandler!.executeTool(name, args)
        : undefined,
    });

    // ── 4. Update conversation history ──
    const updatedHistory = [
      ...history,
      { role: "user" as const, content: params.text },
      { role: "assistant" as const, content: reply },
    ];

    if (updatedHistory.length > this.MAX_HISTORY) {
      this.histories.set(
        params.telegramUserId,
        updatedHistory.slice(updatedHistory.length - this.MAX_HISTORY),
      );
    } else {
      this.histories.set(params.telegramUserId, updatedHistory);
    }

    // ── 5. Memory capture (long-term storage to TencentDB) ──
    try {
      await this.opts.memory.capture(userKey, params.text, reply);
    } catch (error) {
      this.opts.logger.warn(
        `Memory capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return reply;
  }
}

