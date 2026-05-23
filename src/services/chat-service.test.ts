import { describe, expect, test } from "bun:test";
import { ChatService } from "./chat-service.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient, ChatMessage, ChatReplyParams } from "../openai/chat-client.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("ChatService", () => {
  test("recalls before generating a reply and captures after", async () => {
    const calls: string[] = [];
    let replyParams: ChatReplyParams | null = null;
    const memory: MemoryAdapter = {
      recall: async () => {
        calls.push("recall");
        return {
          prependContext: "Known fact: the user likes short answers.",
          appendSystemContext: "Answer briefly.",
        };
      },
      capture: async () => {
        calls.push("capture");
      },
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async (params) => {
        replyParams = params;
        calls.push("reply");
        return "Hello again.";
      },
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });
    const result = await service.replyToUser({ telegramUserId: 99, text: "Hi" });

    if (!replyParams) {
      throw new Error("Expected chatClient.reply to be called");
    }

    expect(result).toBe("Hello again.");
    expect(replyParams!).toEqual({
      systemPrompt: "Answer briefly.",
      userPrompt: "Known fact: the user likes short answers.\n\nHi",
      previousMessages: [] as ChatMessage[],
    });
    expect(calls).toEqual(["recall", "reply", "capture"]);
  });

  test("falls back to chat without memory when recall throws", async () => {
    const memory: MemoryAdapter = {
      recall: async () => {
        throw new Error("recall unavailable");
      },
      capture: async () => {},
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async ({ userPrompt }) => userPrompt,
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });
    const result = await service.replyToUser({ telegramUserId: 7, text: "plain message" });

    // When recall throws, prependContext is empty so userPrompt === params.text
    expect(result).toBe("plain message");
  });

  test("maintains conversation history across calls", async () => {
    const turns: Array<{ userPrompt: string; previousMessages: unknown[] }> = [];
    const memory: MemoryAdapter = {
      recall: async () => ({
        prependContext: "",
        appendSystemContext: "",
      }),
      capture: async () => {},
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async (params) => {
        turns.push({
          userPrompt: params.userPrompt,
          previousMessages: params.previousMessages ?? [],
        });
        return "OK";
      },
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });

    // First turn — history is empty
    await service.replyToUser({ telegramUserId: 1, text: "Hello" });
    expect(turns[0]!.previousMessages).toEqual([]);

    // Second turn — history contains previous user+assistant messages
    await service.replyToUser({ telegramUserId: 1, text: "How are you?" });
    expect(turns[1]!.previousMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "OK" },
    ]);

    // Third turn — history has 4 entries
    await service.replyToUser({ telegramUserId: 1, text: "Good" });
    expect(turns[2]!.previousMessages).toHaveLength(4);
  });

  test("keeps histories separate per user", async () => {
    const turns: Record<number, Array<{ text: string; previousMessages: unknown[] }>> = {};
    const memory: MemoryAdapter = {
      recall: async () => ({
        prependContext: "",
        appendSystemContext: "",
      }),
      capture: async () => {},
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async (params) => {
        // We'll inspect via the service instead
        return "done";
      },
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });

    // User A chats
    await service.replyToUser({ telegramUserId: 10, text: "A-first" });
    // User B chats — should not see A's history
    await service.replyToUser({ telegramUserId: 20, text: "B-first" });
    // User A again — should have only A's history
    await service.replyToUser({ telegramUserId: 10, text: "A-second" });

    // We can verify by checking the internal histories map via a 4th call
    // User A's third turn should show only A's history
    // Using a different approach: capture the previousMessages from the second user's first call
    // to verify that user A's history doesn't bleed into user B's
    let userBFirstParams: { previousMessages?: unknown[] } | null = null;
    let userASecondParams: { previousMessages?: unknown[] } | null = null;
    let callIndex = 0;
    const chatClient2: ChatClient = {
      reply: async (params) => {
        callIndex++;
        if (callIndex === 2) userBFirstParams = params;
        if (callIndex === 3) userASecondParams = params;
        return "done";
      },
    };
    const service2 = new ChatService({ memory, chatClient: chatClient2, logger: noopLogger });

    // User A chats
    await service2.replyToUser({ telegramUserId: 10, text: "A-first" });
    // User B chats — should not see A's history
    await service2.replyToUser({ telegramUserId: 20, text: "B-first" });
    // User A again — should have only A's history
    await service2.replyToUser({ telegramUserId: 10, text: "A-second" });

    // B's first call should have empty history (B has no prior messages)
    expect(userBFirstParams!.previousMessages).toEqual([] as ChatMessage[]);
    // A's second call should have only A's history (not B's)
    expect(userASecondParams!.previousMessages).toEqual([
      { role: "user", content: "A-first" },
      { role: "assistant", content: "done" },
    ]);
  });

  test("limits conversation history to MAX_HISTORY messages", async () => {
    const memory: MemoryAdapter = {
      recall: async () => ({
        prependContext: "",
        appendSystemContext: "",
      }),
      capture: async () => {},
      close: async () => {},
    };

    let callCount = 0;
    let historyLengths: number[] = [];
    const chatClient: ChatClient = {
      reply: async (params) => {
        historyLengths.push(params.previousMessages?.length ?? 0);
        callCount++;
        return `reply-${callCount}`;
      },
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });

    // Send 15 messages (30 history entries) — MAX_HISTORY is 20 (10 turns)
    for (let i = 1; i <= 15; i++) {
      await service.replyToUser({ telegramUserId: 5, text: `msg-${i}` });
    }

    // The 15th call should have at most MAX_HISTORY previous messages
    expect(historyLengths[14]).toBeLessThanOrEqual(20);
    // History should have been trimmed — 14 previous calls = 28 entries, capped at 20
    expect(historyLengths[14]).toBe(20);
  })

  test("returns the reply even when memory capture fails", async () => {
    const memory: MemoryAdapter = {
      recall: async () => ({
        prependContext: "",
        appendSystemContext: "",
      }),
      capture: async () => {
        throw new Error("capture unavailable");
      },
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async () => "still works",
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });
    const result = await service.replyToUser({ telegramUserId: 7, text: "plain message" });

    expect(result).toBe("still works");
  });
});
