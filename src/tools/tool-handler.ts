// ═══════════════════════════════════════════════════════════════════════
//  [Step 28]  TOOL HANDLER — Memory Search Tools for LLM
//  ═══════════════════════════════════════════════════════════════════════
//  Manages tool definitions and execution for memory search tools.
//  The LLM can call these tools during a conversation turn to proactively
//  search the user's long-term memories (L1) and conversation history (L0).
//
//  Security: Tool execution is scoped to the current user's memory session,
//  preventing cross-user data leakage even if the model fabricates a session key.
//
//  Rate limiting: tdai_memory_search + tdai_conversation_search share a
//  combined limit of 3 calls per turn (configurable).
// ═══════════════════════════════════════════════════════════════════════

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

// ─── Step 28a: Tool definition: tdai_memory_search ─────────────────────
//  Searches structured L1 memories (persona, episodic, instruction).
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
        query: { type: "string", description: "Search query describing what you want to recall about the user" },
        limit: { type: "number", description: "Maximum number of results to return (default: 5, max: 20)" },
        type: { type: "string", enum: ["persona", "episodic", "instruction"], description: "Optional filter by memory type" },
        scene: { type: "string", description: "Optional filter by scene name" },
      },
      required: ["query"],
    },
  },
};

// ─── Step 28b: Tool definition: tdai_conversation_search ───────────────
//  Searches raw L0 conversation history (full dialogue records).
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
        query: { type: "string", description: "Search query describing what conversation content you want to find" },
        limit: { type: "number", description: "Maximum number of messages to return (default: 5, max: 20)" },
      },
      required: ["query"],
    },
  },
};

/** All available memory tools the LLM can call. */
export const MEMORY_TOOLS: ToolDefinition[] = [MEMORY_SEARCH_TOOL, CONVERSATION_SEARCH_TOOL];

// ─── Step 28c: ToolHandler class ──────────────────────────────────────
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

  get toolDefinitions(): ToolDefinition[] {
    return MEMORY_TOOLS;
  }

  // ─── Step 28d: Execute a tool by name ──────────────────────────────
  //  Checks call limit first, then routes to the correct handler.
  async executeTool(name: string, args: Record<string, unknown>, userKey: string): Promise<string> {
    const callCount = this.callCountsByUserKey.get(userKey) ?? 0;
    if (callCount >= this.maxCallsPerTurn) {
      this.logger.warn(`[tool-handler] Tool call rejected: ${name} for ${userKey} - limit of ${this.maxCallsPerTurn} per turn reached`);
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

  // ─── Step 28e: Execute tdai_memory_search ──────────────────────────
  private async executeMemorySearch(args: Record<string, unknown>, userKey: string): Promise<string> {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const typeFilter = typeof args.type === "string" ? args.type : undefined;
    const sceneFilter = typeof args.scene === "string" ? args.scene : undefined;

    this.logger.info(
      `[tool-handler] tdai_memory_search: userKey=${userKey}, query="${query.slice(0, 80)}", ` +
      `limit=${limit}, type=${typeFilter ?? "all"}, scene=${sceneFilter ?? "all"}`,
    );

    try {
      const result = await this.core.searchMemories({ query, limit, type: typeFilter, scene: sceneFilter, sessionKey: userKey });
      this.logger.info(`[tool-handler] tdai_memory_search: ${result.total} results (strategy=${result.strategy})`);
      return result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[tool-handler] tdai_memory_search failed: ${msg}`);
      return `Memory search failed: ${msg}`;
    }
  }

  // ─── Step 28f: Execute tdai_conversation_search ─────────────────────
  private async executeConversationSearch(args: Record<string, unknown>, userKey: string): Promise<string> {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);

    this.logger.info(`[tool-handler] tdai_conversation_search: userKey=${userKey}, query="${query.slice(0, 80)}", limit=${limit}`);

    try {
      const result = await this.core.searchConversations({ query, limit, sessionKey: userKey });
      this.logger.info(`[tool-handler] tdai_conversation_search: ${result.total} results`);
      return result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[tool-handler] tdai_conversation_search failed: ${msg}`);
      return `Conversation search failed: ${msg}`;
    }
  }
}
