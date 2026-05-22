import { describe, expect, test } from "bun:test";
import { ChatService } from "./chat-service.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient } from "../openai/chat-client.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("ChatService", () => {
  test("recalls before generating a reply and captures after", async () => {
    const calls: string[] = [];
    let replyParams: { systemPrompt?: string; userPrompt: string } | null = null;
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
    expect(replyParams).toEqual({
      systemPrompt: "Answer briefly.",
      userPrompt: "Known fact: the user likes short answers.\n\nHi",
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

    expect(result).toBe("plain message");
  });

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
