// ═══════════════════════════════════════════════════════════════════════
//  [Step 29]  CHAT SERVICE — Per-User History Management & LRU Eviction
//  ═══════════════════════════════════════════════════════════════════════
//  Manages per-user conversation histories with LRU eviction (max 500 users,
//  20 messages per user). Delegates per-turn logic to ContextAgent.
//
//  Flow per user message:
//    1. Get/create history (LRU tracked)
//    2. Delegate to ContextAgent.reply() for the full turn pipeline
//    3. Update history with user query + assistant reply
// ═══════════════════════════════════════════════════════════════════════

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
  /** Per-user conversation histories (capped at MAX_HISTORY = 20 messages). */
  private readonly histories = new Map<number, ChatMessage[]>();
  /** Max messages per user history before older ones are trimmed. */
  private readonly MAX_HISTORY = 20;
  private readonly contextAgent: ContextAgent;

  constructor(opts: ChatServiceOptions) {
    this.contextAgent = new ContextAgent(opts);
  }

  // ─── Step 29a: Get or create user history with LRU tracking ────────
  //  When access order exceeds MAX_TRACKED_USERS, the least recently used
  //  user is evicted (removed from the Map and access order array).
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

  // ─── Step 29b: Main entry point — reply to a user message ──────────
  //  1. Build the memory session key ("tg:user:{id}")
  //  2. Get/create the user's conversation history
  //  3. Delegate to ContextAgent.reply() for the full pipeline:
  //     L4 check → recall → offload beforeTurn → prompt build → LLM call with tools → offload afterTurn → capture
  //  4. Update history with the new user+assistant pair
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

  // ─── Step 29c: Append to history with cap ───────────────────────────
  //  Adds user message + assistant reply. If history exceeds MAX_HISTORY,
  //  keeps only the most recent MAX_HISTORY messages.
  private updateHistory(telegramUserId: number, history: ChatMessage[], userText: string, reply: string): void {
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
