/**
 * Chat client using the official OpenAI SDK (`openai`).
 *
 * Uses `client.chat.completions.create()` directly with manual step loop
 * for tool call handling. Messages remain in OpenAI format throughout
 * (no CoreMessage ↔ OpenAI format conversion), which avoids the schema
 * mismatch errors seen with the AI SDK.
 */
import OpenAI from "openai";
import type { ToolDefinition, ToolExecutor } from "../tools/tool-handler.ts";

interface ChatClientLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

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
  /**
   * Optional callback invoked after each tool call execution.
   * Used by OffloadService to buffer tool call/result pairs for L1 summarization.
   * Called after executeTool completes, with the tool name, ID, params, and result.
   */
  onToolCallResult?: (params: {
    toolName: string;
    toolCallId: string;
    params: Record<string, unknown>;
    result: string;
  }) => void | Promise<void>;

  /**
   * Optional callback invoked after each step of the tool loop.
   * Receives the current conversation messages array and can modify it in-place.
   * Used by OffloadService to run inline L3 compression + MMD injection
   * between tool call rounds to prevent context bloat during long tool-using turns.
   *
   * Messages are in OpenAI ChatCompletionMessageParam format.
   */
  onStepFinish?: (messages: unknown[]) => Promise<void>;
}

export interface ChatClient {
  reply(params: ChatReplyParams): Promise<string>;
}

type ChatResponseChoice = {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type?: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  finish_reason?: string | null;
};

type ResponsesApiOutputItem = {
  type?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

type CompatibleChatResponse = {
  choices?: ChatResponseChoice[];
  output_text?: string;
  output?: ResponsesApiOutputItem[];
};

export class OpenAiChatClient implements ChatClient {
  /** Max tool call rounds per reply to prevent infinite loops. */
  private readonly MAX_TOOL_ROUNDS = 10;
  private readonly timeoutMs: number;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger?: ChatClientLogger;

  constructor(
    config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs?: number;
    },
    logger?: ChatClientLogger,
  ) {
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.logger = logger;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
  }

  async reply(params: ChatReplyParams): Promise<string> {
    // ── Build messages ──
    const messages: Array<OpenAI.ChatCompletionMessageParam> = [];

    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }

    if (params.previousMessages) {
      for (const msg of params.previousMessages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: "user", content: params.userPrompt });

    // ── Convert tools to OpenAI format ──
    // ToolDefinition already matches OpenAI's ChatCompletionTool shape,
    // so we just cast directly.
    const tools: Array<OpenAI.ChatCompletionTool> | undefined =
      params.tools?.length
        ? (params.tools as Array<OpenAI.ChatCompletionTool>)
        : undefined;

    const hasTools = tools !== undefined && tools.length > 0;

    // ── Manual step loop ──
    // We step through each LLM call manually to control tool execution
    // and to allow inline L3 compression via onStepFinish.
    for (let step = 1; step <= this.MAX_TOOL_ROUNDS; step++) {
      // ── Log ──
      const startedAt = Date.now();
      this.logger?.info?.(
        `[chat] >>> model=${this.model}, round=${step}, messages=${messages.length}, timeout=${this.timeoutMs}ms`,
      );

      // ── Call LLM ──
      try {
        const response = await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            tools: hasTools ? tools : undefined,
          },
          {
            signal: AbortSignal.timeout(this.timeoutMs),
          },
        );

        this.logger?.info?.(
          `[chat] <<< round=${step} (${Date.now() - startedAt}ms)`,
        );

        const compatibleResponse = response as CompatibleChatResponse;
        const choice = compatibleResponse.choices?.[0];
        const responseText = this.extractResponseText(compatibleResponse);
        if (!choice && responseText) {
          return responseText.trim();
        }

        if (!choice) {
          throw new Error(
            `No response choices returned; response keys: ${this.formatResponseKeys(response)}`,
          );
        }

        const message = choice.message;
        if (!message) {
          throw new Error(
            `No assistant message returned; response keys: ${this.formatResponseKeys(response)}`,
          );
        }

        // ── Push assistant message to conversation ──
        // We reconstruct the message to avoid passing back the raw object
        // which may have extra SDK-internal properties.
        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: message.content ?? null,
        };
        if (message.tool_calls && message.tool_calls.length > 0) {
          assistantMsg.tool_calls = message.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
        }
        messages.push(assistantMsg);

        // ── Handle tool calls ──
        if (message.tool_calls && message.tool_calls.length > 0 && hasTools && params.executeTool) {
          for (const tc of message.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              // If arguments can't be parsed, pass empty object
            }

            const resultText = await params.executeTool(tc.function.name, args);

            if (params.onToolCallResult) {
              void params.onToolCallResult({
                toolName: tc.function.name,
                toolCallId: tc.id,
                params: args,
                result: resultText,
              });
            }

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: resultText,
            } as OpenAI.ChatCompletionToolMessageParam);
          }

          // Run onStepFinish for inline L3 compression + MMD injection
          // before the next LLM call. Messages are already in OpenAI format,
          // so ensureOpenAIFormat in the offload service is a no-op.
          if (params.onStepFinish) {
            await params.onStepFinish(messages as unknown[]);
          }

          // Continue to next step — the updated messages (with tool results
          // and possibly compressed) will be sent to the LLM.
          continue;
        }

        // ── No more tool calls — return text ──
        const text = message.content?.trim() ?? "";

        if (text) {
          return text;
        }

        // If text is empty, check finish_reason for more context
        if (choice.finish_reason === "content_filter" || choice.finish_reason === "length") {
          return text;
        }

        // Empty response with no tool calls and no error — should be rare
        if (step === this.MAX_TOOL_ROUNDS) {
          throw new Error("LLM returned an empty reply");
        }
      } catch (error) {
        this.logger?.error?.(
          `[chat] FAILED round=${step} (${Date.now() - startedAt}ms): ${this.formatError(error)}`,
        );
        throw error;
      }
    }

    throw new Error("LLM reached max steps without producing a final answer");
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private extractResponseText(response: CompatibleChatResponse): string | null {
    if (typeof response.output_text === "string") {
      return response.output_text;
    }

    if (!Array.isArray(response.output)) {
      return null;
    }

    const text = response.output
      .flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string")
      .join("");

    return text || null;
  }

  private formatResponseKeys(response: unknown): string {
    if (!response || typeof response !== "object") {
      return "(non-object response)";
    }

    return Object.keys(response).join(", ") || "(no keys)";
  }
}
