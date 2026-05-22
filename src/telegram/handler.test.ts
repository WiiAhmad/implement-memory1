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
        }),
      },
      chatService: {
        replyToUser: async () => "unused",
      },
    });

    await handler(ctx as never);

    expect(replies[0]).toContain("Verification required");
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
});
