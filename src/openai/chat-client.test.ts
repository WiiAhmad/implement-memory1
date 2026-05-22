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
});
