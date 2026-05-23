import OpenAI from "openai";
import type { ToolDefinition, ToolExecutor } from "../tools/tool-handler.ts";

/** A single message in a conversation history. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReplyParams {
  systemPrompt?: string;
  userPrompt: string;
  /** Previous conversation messages for context continuity. */
  previousMessages?: ChatMessage[];
  /**
   * Tool definitions to send to the LLM.
   * When provided, the client handles tool_calls responses automatically
   * by calling executeTool and feeding results back to the LLM.
   */
  tools?: ToolDefinition[];
  /**
   * Callback to execute a tool when the LLM requests it.
   * Required when tools are provided.
   */
  executeTool?: ToolExecutor;
}

export interface ChatClient {
  reply(params: ChatReplyParams): Promise<string>;
}

export class OpenAiChatClient implements ChatClient {
  /** Max tool call rounds per reply to prevent infinite loops. */
  private readonly MAX_TOOL_ROUNDS = 10;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async reply(params: ChatReplyParams): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }

    if (params.previousMessages) {
      for (const msg of params.previousMessages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: "user", content: params.userPrompt });

    // ── Build request ──
    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
    };

    if (params.tools && params.tools.length > 0) {
      requestParams.tools = params.tools;
    }

    // ── Loop for tool calls ──
    let toolRounds = this.MAX_TOOL_ROUNDS;

    while (toolRounds > 0) {
      toolRounds--;

      const response = await this.client.chat.completions.create(requestParams);
      const choice = response.choices[0];

      if (!choice) {
        throw new Error("OpenAI returned no choices");
      }

      // ── Tool call path ──
      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
        // Guard: empty tool_calls array would cause an infinite loop
        if (choice.message.tool_calls.length === 0) {
          return choice.message.content?.trim() || "";
        }

        // Add the assistant's tool call message to history
        const assistantMsg = choice.message as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
        messages.push(assistantMsg);

        if (!params.executeTool) {
          // No executor available — push error results for each tool call
          for (const tc of choice.message.tool_calls) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Tool execution is not available.",
            } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
          }
        } else {
          // Execute each tool call and add the result
          for (const tc of choice.message.tool_calls) {
            if (tc.type !== 'function') {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `Unsupported tool call type: ${tc.type}`,
              } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
              continue;
            }

            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }

            const result = await params.executeTool(tc.function.name, args);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
          }
        }

        // Continue the loop with updated messages
        requestParams.messages = messages;
        continue;
      }

      // ── Text response path ──
      const content = choice.message.content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }

      const refusal = choice.message.refusal?.trim();
      if (refusal) {
        return refusal;
      }

      throw new Error("OpenAI returned an empty reply");
    }

    throw new Error("OpenAI exceeded maximum tool call rounds");
  }
}
