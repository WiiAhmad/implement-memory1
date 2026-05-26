import { describe, expect, test } from "bun:test";
import { createTextHandler } from "./handler.ts";

function createCtx(text: string) {
  const replies: string[] = [];

  return {
    ctx: {
      from: {
        id: 42,
        username: "terry",
        first_name: "Terry",
      },
      message: { text },
      reply: async (message: string) => {
        replies.push(message);
      },
    },
    replies,
  };
}

describe("createTextHandler", () => {
  test("asks an unverified user for a code", async () => {
    const { ctx, replies } = createCtx("hello");
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => false,
        handleUnverifiedInput: async () => ({
          kind: "awaiting_code" as const,
          expiresAt: "2026-05-22T10:15:00.000Z",
          code: "654321",
        }),
      },
      chatService: {
        replyToUser: async () => "unused",
      },
    });

    await handler(ctx as never);

    // Code is NOT in the reply — only server logs show it
    expect(replies[0]).toContain("Verification required");
    expect(replies[0]).not.toContain("654321");
  });

  test("uses chat for a verified user", async () => {
    const { ctx, replies } = createCtx("How are you?");
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => "I am ready.",
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["I am ready."]);
  });

  test("replies with a temporary error when chat generation fails", async () => {
    const { ctx, replies } = createCtx("How are you?");
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          throw new Error("OpenAI unavailable");
        },
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Temporary error. Please try again in a moment."]);
  });

  test("ignores whitespace-only text", async () => {
    const { ctx, replies } = createCtx("   ");
    let chatCalled = false;
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          chatCalled = true;
          return "unused";
        },
      },
    });

    await handler(ctx as never);

    expect(chatCalled).toBe(false);
    expect(replies).toEqual([]);
  });

  test("reveals private key from a pending wallet code before chat", async () => {
    const { ctx, replies } = createCtx("123456");
    let chatCalled = false;
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          chatCalled = true;
          return "unused";
        },
      },
      privateKeyAccessService: {
        consumeNextMessage: async () => ({
          kind: "revealed" as const,
          publicAddress: "Address111",
          privateKey: "PrivateKey111",
        }),
      },
    });

    await handler(ctx as never);

    expect(chatCalled).toBe(false);
    expect(replies).toEqual([
      "Private key for Address111:\nPrivateKey111",
    ]);
  });

  test("cancels pending wallet private key request before chat", async () => {
    const { ctx, replies } = createCtx("hello");
    let chatCalled = false;
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          chatCalled = true;
          return "unused";
        },
      },
      privateKeyAccessService: {
        consumeNextMessage: async () => ({
          kind: "canceled" as const,
          reason: "unexpected_message" as const,
        }),
      },
    });

    await handler(ctx as never);

    expect(chatCalled).toBe(false);
    expect(replies).toEqual([
      "Private key request canceled. Run /wallets-privatekey <public-address> to request a new code.",
    ]);
  });
});
