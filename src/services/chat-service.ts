import { ContextAgent } from "../agent/context-agent.ts";
import type { ContextAgentOptions } from "../agent/context-agent.ts";
import { buildMemorySessionKey } from "../memory/build-memory-config.ts";
import type { ChatMessage } from "../openai/chat-client.ts";

export type ChatServiceOptions = ContextAgentOptions;

export class ChatService {
  /** Max users tracked in memory before LRU eviction. Prevents unbounded Map growth. */
  private static readonly MAX_TRACKED_USERS = 500;

  /** Ordered list of user IDs for LRU eviction (most recently used at the end). */
  private readonly userAccessOrder: number[] = [];
  private readonly histories = new Map<number, ChatMessage[]>();
  private readonly MAX_HISTORY = 20;
  private readonly contextAgent: ContextAgent;

  constructor(opts: ChatServiceOptions) {
    this.contextAgent = new ContextAgent(opts);
  }

  /**
   * Get or create history for a user, tracking LRU access.
   * Evicts the least recently used user when over MAX_TRACKED_USERS.
   */
  private getOrCreateHistory(telegramUserId: number): ChatMessage[] {
    const idx = this.userAccessOrder.indexOf(telegramUserId);
    if (idx !== -1) {
      this.userAccessOrder.splice(idx, 1);
    }
    this.userAccessOrder.push(telegramUserId);

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
    const userKey = buildMemorySessionKey(params.telegramUserId);
    const history = this.getOrCreateHistory(params.telegramUserId);

    const result = await this.contextAgent.reply({
      telegramUserId: params.telegramUserId,
      userKey,
      text: params.text,
      history,
    });

    if (result.updateHistory) {
      this.updateHistory(params.telegramUserId, history, params.text, result.reply);
    }

    return result.reply;
  }

  private updateHistory(
    telegramUserId: number,
    history: ChatMessage[],
    userText: string,
    reply: string,
  ): void {
    const updatedHistory = [
      ...history,
      { role: "user" as const, content: userText },
      { role: "assistant" as const, content: reply },
    ];

    if (updatedHistory.length > this.MAX_HISTORY) {
      this.histories.set(telegramUserId, updatedHistory.slice(-this.MAX_HISTORY));
    } else {
      this.histories.set(telegramUserId, updatedHistory);
    }
  }
}
