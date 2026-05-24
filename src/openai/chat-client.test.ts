import { describe, expect, test, mock } from "bun:test";
import { OpenAiChatClient } from "./chat-client.ts";

// ── Mock the ai package ──

let lastGenerateTextParams: unknown;

mock.module("ai", () => {
  const actual = {
    generateText: async (params: unknown) => {
      lastGenerateTextParams = params;
      return {
        text: "Hello again.",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  } as const;
  return actual;
});

// ── Helpers ──

function createClient(timeoutMs?: number): OpenAiChatClient {
  return new OpenAiChatClient(
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      timeoutMs,
    },
    // noop logger
    { info() {}, warn() {}, error() {} },
  );
}

describe("OpenAiChatClient", () => {
  test("sends the prompts and returns trimmed assistant text", async () => {
    lastGenerateTextParams = undefined;

    const client = createClient();
    const reply = await client.reply({
      systemPrompt: "Answer briefly.",
      userPrompt: "Hi",
    });

    // Verify the params sent to generateText
    const params = lastGenerateTextParams as Record<string, unknown>;
    expect(params.system).toBe("Answer briefly.");
    expect(params.messages).toEqual([
      { role: "user", content: "Hi" },
    ]);

    expect(reply).toBe("Hello again.");
  });

  test("includes conversation history when provided", async () => {
    lastGenerateTextParams = undefined;

    const client = createClient();
    await client.reply({
      systemPrompt: "Be helpful.",
      userPrompt: "What was my last question?",
      previousMessages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "It's sunny!" },
      ],
    });

    const params = lastGenerateTextParams as Record<string, unknown>;
    expect(params.system).toBe("Be helpful.");
    expect(params.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "What's the weather?" },
      { role: "assistant", content: "It's sunny!" },
      { role: "user", content: "What was my last question?" },
    ]);
  });

  test("works without system prompt or history", async () => {
    lastGenerateTextParams = undefined;

    const client = createClient();
    await client.reply({ userPrompt: "Just a message" });

    const params = lastGenerateTextParams as Record<string, unknown>;
    expect(params.system).toBeUndefined();
    expect(params.messages).toEqual([
      { role: "user", content: "Just a message" },
    ]);
  });

  test("passes timeout from config", () => {
    const client = createClient(45_000);
    // Just verify it constructs without error — timeout is used internally
    expect(client).toBeDefined();
  });

  test("handles empty text response", async () => {
    mock.module("ai", () => {
      return {
        generateText: async () => ({
          text: "",
          finishReason: "stop" as const,
          usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
        }),
      };
    });

    // Re-create client so the new mock takes effect
    const client = createClient();

    expect(
      client.reply({ userPrompt: "test" }),
    ).rejects.toThrow("LLM returned an empty reply");
  });

  test("handles content-filter finishReason", async () => {
    mock.module("ai", () => {
      return {
        generateText: async () => ({
          text: "",
          finishReason: "content-filter" as const,
          usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
        }),
      };
    });

    const client = createClient();

    // Content-filter returns empty string (not throw)
    const reply = await client.reply({ userPrompt: "do something bad" });
    expect(reply).toBe("");
  });
});
