import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { OpenAiChatClient } from "./chat-client.ts";

describe("OpenAiChatClient", () => {
  test("sends the prompts and returns trimmed assistant text", async () => {
    let createParams: unknown;
    const client = new OpenAiChatClient(
      {
        chat: {
          completions: {
            create: async (params: unknown) => {
              createParams = params;
              return {
                choices: [
                  {
                    message: {
                      content: "  Hello again.  ",
                    },
                  },
                ],
              };
            },
          },
        },
      } as unknown as OpenAI,
      "gpt-4o-mini",
    );

    const reply = await client.reply({
      systemPrompt: "Answer briefly.",
      userPrompt: "Hi",
    });

    expect(createParams).toEqual({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(reply).toBe("Hello again.");
  });

  test("returns refusal text when OpenAI omits normal content", async () => {
    const client = new OpenAiChatClient(
      {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: null,
                    refusal: "I can't help with that.",
                  },
                },
              ],
            }),
          },
        },
      } as unknown as OpenAI,
      "gpt-4o-mini",
    );

    const reply = await client.reply({
      userPrompt: "Do something disallowed.",
    });

    expect(reply).toBe("I can't help with that.");
  });

  test("includes conversation history when provided", async () => {
    let createParams: unknown;
    const client = new OpenAiChatClient(
      {
        chat: {
          completions: {
            create: async (params: unknown) => {
              createParams = params;
              return {
                choices: [{ message: { content: "Sure!" } }],
              };
            },
          },
        },
      } as unknown as OpenAI,
      "gpt-4o-mini",
    );

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

    expect(createParams).toMatchObject({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "It's sunny!" },
        { role: "user", content: "What was my last question?" },
      ],
    });
  });

  test("works without system prompt or history", async () => {
    let createParams: unknown;
    const client = new OpenAiChatClient(
      {
        chat: {
          completions: {
            create: async (params: unknown) => {
              createParams = params;
              return {
                choices: [{ message: { content: "Reply" } }],
              };
            },
          },
        },
      } as unknown as OpenAI,
      "gpt-4o-mini",
    );

    await client.reply({ userPrompt: "Just a message" });

    expect(createParams).toMatchObject({
      messages: [
        { role: "user", content: "Just a message" },
      ],
    });
  });
});
