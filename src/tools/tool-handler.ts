import type { TdaiCore } from "../../TencentDB-Agent-Memory/src/core/tdai-core.ts";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

// ============================
// Types
// ============================

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
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

// ============================
// Tool schemas
// ============================

const MEMORY_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "tdai_memory_search",
    description:
      "Search through the user's long-term memories (L1 structured records). " +
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
      "Search through past conversation history (L0 raw dialogue records). " +
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
        session_key: {
          type: "string",
          description: "Optional: filter results to a specific session",
        },
      },
      required: ["query"],
    },
  },
};

/** All available memory tools the LLM can call. */
export const MEMORY_TOOLS: ToolDefinition[] = [MEMORY_SEARCH_TOOL, CONVERSATION_SEARCH_TOOL];

// ============================
// ToolHandler
// ============================

/**
 * Manages tool definitions and execution for memory search tools.
 *
 * - Provides OpenAI-compatible tool schemas for tdai_memory_search and tdai_conversation_search
 * - Executes tool calls via TdaiCore
 * - Enforces per-turn call limit (default: 3)
 * - Resets call count between turns
 */
export class ToolHandler {
  private callCount = 0;
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
   * Execute a tool by name with the given arguments.
   * Returns a formatted string result for the LLM.
   * Returns an error message if the tool is unknown or fails.
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.callCount >= this.maxCallsPerTurn) {
      this.logger.warn(
        `[tool-handler] Tool call rejected: ${name} — limit of ${this.maxCallsPerTurn} per turn reached`,
      );
      return "Tool call limit reached (max 3 per turn). Please respond with the information you already have.";
    }
    this.callCount++;

    switch (name) {
      case "tdai_memory_search":
        return await this.executeMemorySearch(args);
      case "tdai_conversation_search":
        return await this.executeConversationSearch(args);
      default:
        this.logger.warn(`[tool-handler] Unknown tool called: ${name}`);
        return `Unknown tool: ${name}`;
    }
  }

  /** Reset the per-turn call counter. Call before each user turn. */
  resetCallCount(): void {
    this.callCount = 0;
  }

  // ── Private executors ──

  private async executeMemorySearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const typeFilter = typeof args.type === "string" ? args.type : undefined;
    const sceneFilter = typeof args.scene === "string" ? args.scene : undefined;

    this.logger.info(
      `[tool-handler] tdai_memory_search: query="${query.slice(0, 80)}", limit=${limit}, ` +
      `type=${typeFilter ?? "all"}, scene=${sceneFilter ?? "all"}`,
    );

    try {
      const result = await this.core.searchMemories({ query, limit, type: typeFilter, scene: sceneFilter });
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

  private async executeConversationSearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const sessionKeyFilter = typeof args.session_key === "string" ? args.session_key : undefined;

    this.logger.info(
      `[tool-handler] tdai_conversation_search: query="${query.slice(0, 80)}", limit=${limit}, ` +
      `session_key=${sessionKeyFilter ?? "all"}`,
    );

    try {
      const result = await this.core.searchConversations({ query, limit, sessionKey: sessionKeyFilter });
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
