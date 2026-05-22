import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { buildMemorySessionKey } from "../memory/build-memory-config.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient } from "../openai/chat-client.ts";

export interface ChatServiceOptions {
  memory: MemoryAdapter;
  chatClient: ChatClient;
  logger: Logger;
}

export class ChatService {
  constructor(private readonly opts: ChatServiceOptions) {}

  async replyToUser(params: { telegramUserId: number; text: string }): Promise<string> {
    const userKey = buildMemorySessionKey(params.telegramUserId);

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

    const userPrompt = [prependContext, params.text].filter(Boolean).join("\n\n");
    const reply = await this.opts.chatClient.reply({
      systemPrompt: appendSystemContext || undefined,
      userPrompt,
    });

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
