import { describe, expect, test } from "bun:test";
import { ToolHandler } from "./tool-handler.ts";

/**
 * Minimal mock TdaiCore that satisfies the interface used by ToolHandler.
 */
function createMockCore(calls?: { memory?: unknown; conversation?: unknown }) {
  return {
    searchMemories: async (params: { query: string; limit: number; type?: string; scene?: string; sessionKey?: string }) => {
      if (calls) calls.memory = params;
      return {
        text: `Found 2 memories for "${params.query}":\n- [persona] likes cats\n- [episodic] went to Tokyo`,
        total: 2,
        strategy: "keyword",
      };
    },
    searchConversations: async (params: { query: string; limit: number; sessionKey?: string }) => {
      if (calls) calls.conversation = params;
      return {
        text: `Found 1 message for "${params.query}":\n[user] I love cats!`,
        total: 1,
      };
    },
  };
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("ToolHandler", () => {
  test("provides tool definitions for both tools", () => {
    const handler = new ToolHandler({ core: createMockCore() as never, logger: noopLogger });
    const defs = handler.toolDefinitions;

    expect(defs).toHaveLength(2);
    expect(defs[0]!.function.name).toBe("tdai_memory_search");
    expect(defs[1]!.function.name).toBe("tdai_conversation_search");
  });

  test("executes tdai_memory_search and returns formatted result", async () => {
    const handler = new ToolHandler({ core: createMockCore() as never, logger: noopLogger });
    const result = await handler.executeTool("tdai_memory_search", {
      query: "cats",
      limit: 5,
    }, "tg:user:42");

    expect(result).toContain("Found 2 memories");
    expect(result).toContain("cats");
    expect(result).toContain("[persona]");
  });

  test("executes tdai_conversation_search and returns formatted result", async () => {
    const calls: { conversation?: unknown } = {};
    const handler = new ToolHandler({ core: createMockCore(calls) as never, logger: noopLogger });
    const result = await handler.executeTool("tdai_conversation_search", {
      query: "cats",
      limit: 5,
      session_key: "tg:user:999",
    }, "tg:user:42");

    expect(result).toContain("Found 1 message");
    expect(result).toContain("cats");
    expect(calls.conversation).toEqual({
      query: "cats",
      limit: 5,
      sessionKey: "tg:user:42",
    });
  });

  test("scopes tdai_memory_search to the current user key", async () => {
    const calls: { memory?: unknown } = {};
    const handler = new ToolHandler({ core: createMockCore(calls) as never, logger: noopLogger });

    await handler.executeTool("tdai_memory_search", { query: "cats" }, "tg:user:42");

    expect(calls.memory).toMatchObject({
      query: "cats",
      limit: 5,
      sessionKey: "tg:user:42",
    });
  });

  test("returns error for unknown tool name", async () => {
    const handler = new ToolHandler({ core: createMockCore() as never, logger: noopLogger });
    const result = await handler.executeTool("unknown_tool", {}, "tg:user:42");
    expect(result).toBe("Unknown tool: unknown_tool");
  });

  test("enforces per-turn call limit", async () => {
    const handler = new ToolHandler({
      core: createMockCore() as never,
      logger: noopLogger,
      maxCallsPerTurn: 3,
    });

    const r1 = await handler.executeTool("tdai_memory_search", { query: "a" }, "tg:user:42");
    expect(r1).toContain("Found");

    const r2 = await handler.executeTool("tdai_memory_search", { query: "b" }, "tg:user:42");
    expect(r2).toContain("Found");

    const r3 = await handler.executeTool("tdai_memory_search", { query: "c" }, "tg:user:42");
    expect(r3).toContain("Found");

    const r4 = await handler.executeTool("tdai_memory_search", { query: "d" }, "tg:user:42");
    expect(r4).toContain("Tool call limit reached");
  });

  test("resetCallCount allows more calls", async () => {
    const handler = new ToolHandler({
      core: createMockCore() as never,
      logger: noopLogger,
      maxCallsPerTurn: 1,
    });

    const r1 = await handler.executeTool("tdai_memory_search", { query: "a" }, "tg:user:42");
    expect(r1).toContain("Found");

    const r2 = await handler.executeTool("tdai_memory_search", { query: "b" }, "tg:user:42");
    expect(r2).toContain("Tool call limit reached");

    handler.resetCallCount();
    const r3 = await handler.executeTool("tdai_memory_search", { query: "c" }, "tg:user:42");
    expect(r3).toContain("Found");
  });

  test("handles tool execution errors gracefully", async () => {
    const failingCore = {
      searchMemories: async () => {
        throw new Error("DB connection failed");
      },
    };

    const handler = new ToolHandler({ core: failingCore as never, logger: noopLogger });
    const result = await handler.executeTool("tdai_memory_search", { query: "test" }, "tg:user:42");
    expect(result).toContain("Memory search failed");
    expect(result).toContain("DB connection failed");
  });
});
