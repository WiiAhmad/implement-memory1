import type { TdaiCore } from "../../TencentDB-Agent-Memory/src/core/tdai-core.ts";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

/** OpenAI-compatible tool definition (JSON schema). */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Callback to execute a tool when the LLM requests it. */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  userKey?: string,
) => Promise<string>;

const MEMORY_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "tdai_memory_search",
    description:
      "Search through the current user's long-term memories (L1 structured records). " +
      "Use this when you need to recall specific information about the user's preferences, " +
      "past events, instructions, or context from previous conversations. " +
      "Returns relevant memory records ranked by relevance. " +
      "Limit: tdai_memory_search and tdai_conversation_search share a combined limit of 3 calls per turn.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing what you want to recall about the user",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 5, max: 20)",
        },
        type: {
          type: "string",
          enum: ["persona", "episodic", "instruction"],
          description:
            "Optional filter by memory type: persona (identity/preferences), " +
            "episodic (events/activities), instruction (user rules/commands)",
        },
        scene: {
          type: "string",
          description: "Optional filter by scene name",
        },
      },
      required: ["query"],
    },
  },
};

const CONVERSATION_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "tdai_conversation_search",
    description:
      "Search through the current user's past conversation history (L0 raw dialogue records). " +
      "Use this when tdai_memory_search (structured memories) doesn't have the information you need, " +
      "or when you want to find specific past conversations, dialogue context, or exact words " +
      "the user said before. Returns relevant individual messages ranked by relevance. " +
      "Limit: tdai_memory_search and tdai_conversation_search share a combined limit of 3 calls per turn.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing what conversation content you want to find",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 5, max: 20)",
        },
      },
      required: ["query"],
    },
  },
};

/** All available memory tools the LLM can call. */
export const MEMORY_TOOLS: ToolDefinition[] = [MEMORY_SEARCH_TOOL, CONVERSATION_SEARCH_TOOL];

/**
 * Manages tool definitions and execution for memory search tools.
 *
 * Tool execution is explicitly scoped to the current Telegram memory session.
 * This prevents one user from searching another user's L0/L1 records, even if
 * the model tries to provide a different session key in tool arguments.
 */
export class ToolHandler {
  private readonly callCountsByUserKey = new Map<string, number>();
  private readonly maxCallsPerTurn: number;
  private readonly core: TdaiCore;
  private readonly logger: Logger;

  constructor(opts: { core: TdaiCore; logger: Logger; maxCallsPerTurn?: number }) {
    this.core = opts.core;
    this.logger = opts.logger;
    this.maxCallsPerTurn = opts.maxCallsPerTurn ?? 3;
  }

  /** OpenAI-compatible tool definitions for sending in the API request. */
  get toolDefinitions(): ToolDefinition[] {
    return MEMORY_TOOLS;
  }

  /**
   * Execute a tool by name with the given arguments and current user scope.
   * Returns a formatted string result for the LLM.
   */
  async executeTool(name: string, args: Record<string, unknown>, userKey: string): Promise<string> {
    const callCount = this.callCountsByUserKey.get(userKey) ?? 0;
    if (callCount >= this.maxCallsPerTurn) {
      this.logger.warn(
        `[tool-handler] Tool call rejected: ${name} for ${userKey} - limit of ${this.maxCallsPerTurn} per turn reached`,
      );
      return "Tool call limit reached (max 3 per turn). Please respond with the information you already have.";
    }
    this.callCountsByUserKey.set(userKey, callCount + 1);

    switch (name) {
      case "tdai_memory_search":
        return await this.executeMemorySearch(args, userKey);
      case "tdai_conversation_search":
        return await this.executeConversationSearch(args, userKey);
      default:
        this.logger.warn(`[tool-handler] Unknown tool called: ${name}`);
        return `Unknown tool: ${name}`;
    }
  }

  /** Reset the per-turn call counter. Call before each user turn. */
  resetCallCount(userKey?: string): void {
    if (userKey) {
      this.callCountsByUserKey.delete(userKey);
      return;
    }
    this.callCountsByUserKey.clear();
  }

  private async executeMemorySearch(
    args: Record<string, unknown>,
    userKey: string,
  ): Promise<string> {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const typeFilter = typeof args.type === "string" ? args.type : undefined;
    const sceneFilter = typeof args.scene === "string" ? args.scene : undefined;

    this.logger.info(
      `[tool-handler] tdai_memory_search: userKey=${userKey}, query="${query.slice(0, 80)}", ` +
      `limit=${limit}, type=${typeFilter ?? "all"}, scene=${sceneFilter ?? "all"}`,
    );

    try {
      const result = await this.core.searchMemories({
        query,
        limit,
        type: typeFilter,
        scene: sceneFilter,
        sessionKey: userKey,
      });
      this.logger.info(
        `[tool-handler] tdai_memory_search: ${result.total} results (strategy=${result.strategy})`,
      );
      return result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[tool-handler] tdai_memory_search failed: ${msg}`);
      return `Memory search failed: ${msg}`;
    }
  }

  private async executeConversationSearch(
    args: Record<string, unknown>,
    userKey: string,
  ): Promise<string> {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);

    this.logger.info(
      `[tool-handler] tdai_conversation_search: userKey=${userKey}, query="${query.slice(0, 80)}", limit=${limit}`,
    );

    try {
      const result = await this.core.searchConversations({ query, limit, sessionKey: userKey });
      this.logger.info(
        `[tool-handler] tdai_conversation_search: ${result.total} results`,
      );
      return result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[tool-handler] tdai_conversation_search failed: ${msg}`);
      return `Conversation search failed: ${msg}`;
    }
  }
}
