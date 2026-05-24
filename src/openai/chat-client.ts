/**
 * Chat client using Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 *
 * Uses `generateText` with "compatible" mode to support any OpenAI-compatible
 * backend. The provider is created once in the constructor and cached for
 * connection reuse across all chat calls.
 */
import { generateText, jsonSchema, type CoreMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
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
}

export interface ChatClient {
  reply(params: ChatReplyParams): Promise<string>;
}

export class OpenAiChatClient implements ChatClient {
  /** Max tool call rounds per reply to prevent infinite loops. */
  private readonly MAX_TOOL_ROUNDS = 10;
  private readonly timeoutMs: number;
  private readonly provider: ReturnType<typeof createOpenAI>;
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
    this.provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      compatibility: "compatible",
    });
  }

  async reply(params: ChatReplyParams): Promise<string> {
    // ── Build messages ──
    const messages: CoreMessage[] = [];

    if (params.previousMessages) {
      for (const msg of params.previousMessages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: "user", content: params.userPrompt });

    // ── Convert tools to AI SDK format ──
    const tools: Record<
      string,
      {
        description: string;
        inputSchema: ReturnType<typeof jsonSchema>;
        execute: (
          args: Record<string, unknown>,
          options: { toolCallId: string },
        ) => Promise<string>;
      }
    > = {};

    if (params.tools && params.tools.length > 0 && params.executeTool) {
      for (const t of params.tools) {
        const name = t.function.name;
        tools[name] = {
          description: t.function.description,
          inputSchema: jsonSchema(t.function.parameters),
          execute: async (args, { toolCallId }) => {
            const result = await params.executeTool!(name, args);
            // Notify the onToolCallResult callback (fire-and-forget for offload)
            if (params.onToolCallResult) {
              void params.onToolCallResult({
                toolName: name,
                toolCallId,
                params: args,
                result,
              });
            }
            return result;
          },
        };
      }
    }

    const hasTools = Object.keys(tools).length > 0;

    // ── Log ──
    const startedAt = Date.now();
    this.logger?.info?.(
      `[chat] >>> model=${this.model}, round=1, messages=${messages.length + (params.systemPrompt ? 1 : 0)}, timeout=${this.timeoutMs}ms`,
    );

    // ── Call LLM ──
    try {
      const result = await generateText({
        model: this.provider.chat(this.model),
        system: params.systemPrompt,
        messages,
        tools: hasTools ? tools : undefined,
        maxSteps: hasTools ? this.MAX_TOOL_ROUNDS : 1,
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });

      this.logger?.info?.(
        `[chat] <<< round=1 (${Date.now() - startedAt}ms)`,
      );

      const text = result.text?.trim() ?? "";

      if (text) {
        return text;
      }

      // If text is empty, check finishReason for more context
      if (result.finishReason === "content-filter" || result.finishReason === "error") {
        return text;
      }

      throw new Error("LLM returned an empty reply");
    } catch (error) {
      this.logger?.error?.(
        `[chat] FAILED round=1 (${Date.now() - startedAt}ms): ${this.formatError(error)}`,
      );
      throw error;
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
