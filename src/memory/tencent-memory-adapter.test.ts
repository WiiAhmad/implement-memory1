import { describe, expect, test } from "bun:test";
import { TencentMemoryAdapter } from "./tencent-memory-adapter.ts";

type CoreLike = ConstructorParameters<typeof TencentMemoryAdapter>[0];

describe("TencentMemoryAdapter", () => {
  test("recall forwards the query and user key", async () => {
    let call: { query: string; userKey: string } | null = null;
    const adapter = new TencentMemoryAdapter({
      handleBeforeRecall: async (query: string, userKey: string) => {
        call = { query, userKey };
        return {
          prependContext: "Known fact: likes short answers.",
          appendSystemContext: "Answer briefly.",
        };
      },
      handleTurnCommitted: async () => undefined,
      destroy: async () => undefined,
    } as unknown as CoreLike);

    const result = await adapter.recall("tg:user:42", "hello");

    if (!call) {
      throw new Error("Expected recall to be called");
    }

    expect(call!).toEqual({
      query: "hello",
      userKey: "tg:user:42",
    });
    expect(result).toEqual({
      prependContext: "Known fact: likes short answers.",
      appendSystemContext: "Answer briefly.",
    });
  });

  test("capture commits a completed turn keyed by the provided user", async () => {
    let capturedTurn: unknown;
    const adapter = new TencentMemoryAdapter({
      handleBeforeRecall: async () => ({}) as never,
      handleTurnCommitted: async (turn: unknown) => {
        capturedTurn = turn;
      },
      destroy: async () => undefined,
    } as unknown as CoreLike);
    const originalNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      await adapter.capture("tg:user:42", "Hello there", "Hi back");
    } finally {
      Date.now = originalNow;
    }

    expect(capturedTurn).toEqual({
      userText: "Hello there",
      assistantText: "Hi back",
      sessionKey: "tg:user:42",
      startedAt: 1700000000000,
      messages: [
        {
          id: "user-1700000000000",
          role: "user",
          content: "Hello there",
          timestamp: 1700000000000,
        },
        {
          id: "assistant-1700000000001",
          role: "assistant",
          content: "Hi back",
          timestamp: 1700000000001,
        },
      ],
    });
  });

  test("close destroys the underlying core", async () => {
    let destroyed = false;
    const adapter = new TencentMemoryAdapter({
      handleBeforeRecall: async () => ({}) as never,
      handleTurnCommitted: async () => undefined,
      destroy: async () => {
        destroyed = true;
      },
    } as unknown as CoreLike);

    await adapter.close();

    expect(destroyed).toBe(true);
  });
});
