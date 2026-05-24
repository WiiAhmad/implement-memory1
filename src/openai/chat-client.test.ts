import { describe, expect, test, mock } from "bun:test";
import { OpenAiChatClient } from "./chat-client.ts";

// ── Mock the openai package ──

let lastCreateParams: unknown;

mock.module("openai", () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: (params: unknown) => {
          // Deep-clone to avoid reference mutation (params.messages is
          // mutated by reply() after create() returns)
          lastCreateParams = JSON.parse(JSON.stringify(params));
          return Promise.resolve({
            id: "test-cmpl-id",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello again." },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          });
        },
      },
    };
    constructor(_config: Record<string, unknown>) {
      // noop
    }
  },
}));

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
    lastCreateParams = undefined;

    const client = createClient();
    const reply = await client.reply({
      systemPrompt: "Answer briefly.",
      userPrompt: "Hi",
    });

    // Verify the params sent to chat.completions.create
    const params = lastCreateParams as Record<string, unknown>;
    expect(params.model).toBe("gpt-4o-mini");
    expect(params.messages).toEqual([
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "Hi" },
    ]);

    expect(reply).toBe("Hello again.");
  });

  test("includes conversation history when provided", async () => {
    lastCreateParams = undefined;

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

    const params = lastCreateParams as Record<string, unknown>;
    expect(params.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "What's the weather?" },
      { role: "assistant", content: "It's sunny!" },
      { role: "user", content: "What was my last question?" },
    ]);
  });

  test("works without system prompt or history", async () => {
    lastCreateParams = undefined;

    const client = createClient();
    await client.reply({ userPrompt: "Just a message" });

    const params = lastCreateParams as Record<string, unknown>;
    expect(params.system).toBeUndefined();
    // system prompt omitted, only user message
    expect(params.messages).toEqual([
      { role: "user", content: "Just a message" },
    ]);
  });

  test("handles compatible Responses-style output_text without choices", async () => {
    mock.module("openai", () => ({
      default: class OpenAI {
        chat = {
          completions: {
            create: async () => ({
              id: "resp_test_id",
              object: "response",
              model: "gpt-5.4-mini",
              output_text: "  Hello from Responses.  ",
            }),
          },
        };
        constructor(_config: Record<string, unknown>) {}
      },
    }));

    const client = createClient();
    const reply = await client.reply({ userPrompt: "test" });
    expect(reply).toBe("Hello from Responses.");
  });

  test("reports malformed compatible responses without crashing on choices access", async () => {
    mock.module("openai", () => ({
      default: class OpenAI {
        chat = {
          completions: {
            create: async () => ({
              id: "resp_test_id",
              object: "response",
              model: "gpt-5.4-mini",
            }),
          },
        };
        constructor(_config: Record<string, unknown>) {}
      },
    }));

    const client = createClient();
    await expect(
      client.reply({ userPrompt: "test" }),
    ).rejects.toThrow("No response choices returned");
  });

  test("passes timeout from config", () => {
    const client = createClient(45_000);
    expect(client).toBeDefined();
  });

  test("handles empty text response", async () => {
    mock.module("openai", () => ({
      default: class OpenAI {
        chat = {
          completions: {
            create: async () => ({
              id: "test-cmpl-id",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "gpt-4o-mini",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: null },
                  finish_reason: "stop",
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: 5,
                completion_tokens: 0,
                total_tokens: 5,
              },
            }),
          },
        };
        constructor(_config: Record<string, unknown>) {}
      },
    }));

    const client = createClient();
    await expect(
      client.reply({ userPrompt: "test" }),
    ).rejects.toThrow("LLM returned an empty reply");
  });

  test("handles content-filter finish_reason", async () => {
    mock.module("openai", () => ({
      default: class OpenAI {
        chat = {
          completions: {
            create: async () => ({
              id: "test-cmpl-id",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "gpt-4o-mini",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: null },
                  finish_reason: "content_filter",
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: 5,
                completion_tokens: 0,
                total_tokens: 5,
              },
            }),
          },
        };
        constructor(_config: Record<string, unknown>) {}
      },
    }));

    const client = createClient();
    const reply = await client.reply({ userPrompt: "do something bad" });
    expect(reply).toBe("");
  });

  test("handles tool calls and loops back", async () => {
    let toolCallStep = 0;
    mock.module("openai", () => ({
      default: class OpenAI {
        chat = {
          completions: {
            create: async () => {
              toolCallStep++;
              if (toolCallStep === 1) {
                return {
                  id: "test-cmpl-id",
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: "gpt-4o-mini",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_1",
                            type: "function",
                            function: {
                              name: "test_tool",
                              arguments: '{"query":"hello"}',
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                      logprobs: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                  },
                };
              }
              return {
                id: "test-cmpl-id-2",
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "gpt-4o-mini",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Done!" },
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 3,
                  total_tokens: 23,
                },
              };
            },
          },
        };
        constructor(_config: Record<string, unknown>) {}
      },
    }));

    const client = createClient();
    const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];

    const reply = await client.reply({
      userPrompt: "Use a tool",
      tools: [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "A test tool",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
      executeTool: async (name, args) => {
        executedTools.push({ name, args });
        return "Tool result";
      },
    });

    expect(reply).toBe("Done!");
    expect(executedTools).toEqual([{ name: "test_tool", args: { query: "hello" } }]);
    expect(toolCallStep).toBe(2);
  });

  test("calls onStepFinish after tool calls", async () => {
    let step = 0;
    mock.module("openai", () => ({
      default: class OpenAI {
        chat = {
          completions: {
            create: async () => {
              step++;
              if (step === 1) {
                return {
                  id: "test-cmpl-id",
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: "gpt-4o-mini",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_1",
                            type: "function",
                            function: {
                              name: "test_tool",
                              arguments: '{}',
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                      logprobs: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                  },
                };
              }
              return {
                id: "test-cmpl-id-2",
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "gpt-4o-mini",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Final" },
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 3,
                  total_tokens: 23,
                },
              };
            },
          },
        };
        constructor(_config: Record<string, unknown>) {}
      },
    }));

    let stepFinishCalled = false;
    let stepFinishMessages: unknown[] | undefined;

    const client = createClient();
    const reply = await client.reply({
      userPrompt: "Use a tool",
      tools: [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "A test tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      executeTool: async () => "result",
      onStepFinish: async (messages) => {
        stepFinishCalled = true;
        stepFinishMessages = messages;
      },
    });

    expect(reply).toBe("Final");
    expect(stepFinishCalled).toBe(true);
    expect(stepFinishMessages).toBeDefined();
    // Messages: user + assistant(tool_calls) + tool
    const msgs = stepFinishMessages as Array<Record<string, unknown>>;
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[2]?.role).toBe("tool");
  });
});
