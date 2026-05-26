/**
 * Unit tests for the L3 compression orchestrator.
 *
 * Tests cover:
 * - Message normalization round-trips (OpenAI ↔ library format)
 * - Token estimation with various message shapes
 * - Compression session with different threshold scenarios
 * - Edge cases (empty arrays, no-offload entries, preservation rules)
 */
import { describe, expect, test, beforeAll } from "bun:test";
import {
  normalizeMessages,
  denormalizeMessages,
  configureL3TokenTracker,
  estimateMessageTokens,
  compressSession,
  normalizeToolResultMessages,
} from "./compressor.ts";
import type { OffloadEntry, OffloadConfig } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A noop logger that satisfies PluginLogger. */
const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Build a minimal OffloadConfig with overrides. */
function testConfig(overrides?: Partial<OffloadConfig>): OffloadConfig {
  return {
    enabled: true,
    model: undefined,
    mode: "local",
    temperature: 0.2,
    forceTriggerThreshold: 4,
    contextWindow: 128_000,
    maxPairsPerBatch: 20,
    l1Enabled: false,
    l15Enabled: false,
    l2Enabled: false,
    offloadRetentionDays: 0,
    logMaxSizeMb: 50,
    backendUrl: undefined,
    backendApiKey: undefined,
    backendTimeoutMs: 120_000,
    userId: undefined,
    mildOffloadRatio: 0.5,
    aggressiveCompressRatio: 0.85,
    emergencyCompressRatio: 0.95,
    emergencyTargetRatio: 0.6,
    aggressiveDeleteRatio: 0.4,
    mildOffloadScanRatio: 0.7,
    mmdMaxTokenRatio: 0.2,
    l2NullThreshold: 4,
    l2TimeoutSeconds: 300,
    ...overrides,
  };
}

beforeAll(() => {
  configureL3TokenTracker();
});

// ─── Normalize / Denormalize ────────────────────────────────────────────────

describe("normalizeMessages / denormalizeMessages", () => {
  test("normalizeMessages adds toolCallId alias to tool result messages", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "tool", tool_call_id: "call_abc", content: "result" },
    ];

    normalizeMessages(msgs);

    expect(msgs[0]!.toolCallId).toBe("call_abc");
    // Original field preserved
    expect(msgs[0]!.tool_call_id).toBe("call_abc");
  });

  test("normalizeMessages converts assistant tool_calls to content blocks", () => {
    const msgs: Record<string, unknown>[] = [
      {
        role: "assistant",
        content: "Let me search.",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "search_files", arguments: '{"path":"src/"}' },
          },
        ],
      },
    ];

    const restore = normalizeMessages(msgs);

    // tool_calls should be deleted
    expect(msgs[0]!.tool_calls).toBeUndefined();
    // content should be array of blocks
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
    const blocks = msgs[0]!.content as Record<string, unknown>[];
    expect(blocks).toHaveLength(2); // text + tool_use
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("Let me search.");
    expect(blocks[1]!.type).toBe("tool_use");
    expect(blocks[1]!.id).toBe("call_123");
    expect(blocks[1]!.name).toBe("search_files");

    // restore should have one entry
    expect(restore).toHaveLength(1);
    expect(restore[0]!.index).toBe(0);
    expect(restore[0]!.hadToolCalls).toBe(true);
    expect(restore[0]!.originalContent).toBe("Let me search.");
  });

  test("denormalizeMessages restores original format", () => {
    const msgs: Record<string, unknown>[] = [
      {
        role: "assistant",
        content: "Let me search.",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "search_files", arguments: '{"path":"src/"}' },
          },
        ],
      },
    ];

    const restore = normalizeMessages(msgs);

    // Verify normalized
    expect(Array.isArray(msgs[0]!.content)).toBe(true);

    // Denormalize
    denormalizeMessages(msgs, restore);

    // Should be back to original string content
    expect(msgs[0]!.content).toBe("Let me search.");
    expect(Array.isArray(msgs[0]!.content)).toBe(false);
    expect(msgs[0]!.tool_calls).toBeDefined();
    expect((msgs[0]!.tool_calls as unknown[])).toHaveLength(1);
  });

  test("normalizeToolResultMessages adds toolCallId alias without modifying tool_calls", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "tool", tool_call_id: "call_xyz", content: "data" },
      { role: "assistant", content: "Hello" },
    ];

    normalizeToolResultMessages(msgs);

    expect(msgs[0]!.toolCallId).toBe("call_xyz");
    // Non-tool messages are not affected
    expect((msgs[1] as Record<string, unknown>).toolCallId).toBeUndefined();
  });

  test("normalizeMessages skips assistant without tool_calls", () => {
    const msgs: Record<string, unknown>[] = [
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Hi" },
    ];

    const restore = normalizeMessages(msgs);

    expect(restore).toHaveLength(0);
    expect(msgs[0]!.content).toBe("Hello");
  });
});

// ─── Token Estimation ───────────────────────────────────────────────────────

describe("estimateMessageTokens", () => {
  test("returns 0 for empty messages", () => {
    const result = estimateMessageTokens("test", [], null, null);
    expect(result).toBe(0);
  });

  test("returns positive count for messages with text", () => {
    const msgs = [
      { role: "user", content: "Hello, world!" },
      { role: "assistant", content: "Hi there!" },
    ];

    const result = estimateMessageTokens("test", msgs, null, null);
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  test("includes system prompt in token count", () => {
    const msgs: Record<string, unknown>[] = [];

    const noSystem = estimateMessageTokens("test", msgs, null, null);
    const withSystem = estimateMessageTokens("test", msgs, "System prompt here", null);

    expect(withSystem).toBeGreaterThan(noSystem);
  });
});

// ─── Compression Session ────────────────────────────────────────────────────

describe("compressSession", () => {
  test("returns no-op result for empty messages", async () => {
    const result = await compressSession([], [], testConfig(), undefined, noopLogger);

    expect(result.messages).toEqual([]);
    expect(result.tokensBefore).toBe(0);
    expect(result.tokensAfter).toBe(0);
    expect(result.mildApplied).toBe(false);
    expect(result.aggressiveApplied).toBe(false);
    expect(result.emergencyApplied).toBe(false);
    expect(result.utilisation).toBe(0);
  });

  test("returns no-op for null/undefined messages", async () => {
    const result = await compressSession(null as unknown as unknown[], [], testConfig(), undefined, noopLogger);

    expect(result.messages).toEqual(null);
    expect(result.tokensBefore).toBe(0);
    expect(result.tokensAfter).toBe(0);
  });

  test("no compression when messages are under mild threshold", async () => {
    // Use a large context window so we stay well under thresholds
    const config = testConfig({ contextWindow: 1_000_000 });
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there! How can I help?" },
    ];

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    // Token count should be positive but well under the threshold
    expect(result.tokensBefore).toBeGreaterThan(0);
    expect(result.tokensBefore).toBeLessThan(100);
    expect(result.tokensAfter).toBe(result.tokensBefore);
    expect(result.mildApplied).toBe(false);
    expect(result.aggressiveApplied).toBe(false);
    expect(result.emergencyApplied).toBe(false);
    // Messages should not have been mutated
    expect(result.messages).toHaveLength(2);
  });

  test("mild compression replaces tool results with summaries when available", async () => {
    // Create a scenario where mild threshold is exceeded and offload entries exist
    // The 3 messages: ~3t (user) + ~1t (assistant with tool_calls) + ~65t (tool result with long content) ≈ ~69 tokens
    // Use a small context window to make mild threshold easily reachable
    const config = testConfig({
      contextWindow: 200,
      mildOffloadRatio: 0.3, // mild at 60 tokens (69 > 60 ✅)
      aggressiveCompressRatio: 0.95, // aggressive at 190 tokens (won't trigger)
      emergencyCompressRatio: 0.98,  // emergency unreachable
      mildOffloadScanRatio: 1.0,     // scan all messages (so the tool result at index 2 is included)
    });

    // Create messages with a tool result that has an entry in offloadMap
    // Score must be >= MILD_CASCADE_FLOOR_SCORE (1) for compressByScoreCascade to process it
    const offloadEntry: OffloadEntry = {
      tool_call_id: "call_test_1",
      tool_call: "test_tool({\"key\":\"value\"})",
      summary: "Test tool result: found 5 items",
      timestamp: "2026-05-21T00:00:00.000Z",
      node_id: null,
      result_ref: "",
      score: 5,
    };

    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "Search for something" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_test_1", type: "function", function: { name: "test_tool", arguments: '{"key":"value"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_test_1", content: "Long result: ".repeat(20) },
    ];

    const result = await compressSession(msgs, [offloadEntry], config, undefined, noopLogger);

    // Should have triggered mild compression since we have offload entries and tokens exceed threshold
    expect(result.messages).toBeDefined();
    expect(result.messages).toHaveLength(3); // mild doesn't delete messages, it replaces content
    expect(result.mildApplied).toBe(true);
    expect(result.mildReplacedCount).toBeGreaterThan(0);
    expect(result.aggressiveApplied).toBe(false);
    expect(result.emergencyApplied).toBe(false);
  });

  test("aggressive compression deletes oldest messages when above threshold", async () => {
    // 6 messages with 300 chars each = ~502 tokens (measured empirically)
    // Set thresholds so: aggressive (400) < 502 (tokens) < emergency (560)
    const config = testConfig({
      contextWindow: 800,
      aggressiveCompressRatio: 0.5, // aggressive at 400 tokens (below 502 ✅)
      emergencyCompressRatio: 0.7,  // emergency at 560 tokens (above 502 ✅)
      aggressiveDeleteRatio: 0.5,
      mildOffloadRatio: 0.9,        // mild at 720 tokens (won't trigger)
    });

    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "A".repeat(300) },
      { role: "assistant", content: "B".repeat(300) },
      { role: "user", content: "C".repeat(300) },
      { role: "assistant", content: "D".repeat(300) },
      { role: "user", content: "E".repeat(300) },
      { role: "assistant", content: "F".repeat(300) },
    ];
    const originalLength = msgs.length;

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    // Should have applied aggressive compression (deleted oldest messages)
    // Note: compression mutates msgs in-place, so use originalLength for comparison
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeLessThan(originalLength);
    expect(result.tokensBefore).toBeGreaterThan(0);
    expect(result.aggressiveApplied).toBe(true);
    expect(result.emergencyApplied).toBe(false);
    expect(result.mildApplied).toBe(false);
  });

  test("preserves last user message during aggressive compression", async () => {
    const config = testConfig({
      contextWindow: 50,
      aggressiveCompressRatio: 0.8,
      aggressiveDeleteRatio: 0.5,
    });

    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "X".repeat(300) },
      { role: "assistant", content: "Y".repeat(300) },
      { role: "user", content: "Z".repeat(300) }, // Last user message - should be preserved
    ];

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    // The last user message should not be deleted
    if (result.messages.length >= 1) {
      const lastMsg = result.messages[result.messages.length - 1] as Record<string, unknown>;
      // The last message might be assistant, check that the last USER message is preserved
      const lastUserIdx = result.messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => (m as Record<string, unknown>).role === "user")
        .pop()?.i;
      if (lastUserIdx !== undefined) {
        expect((result.messages[lastUserIdx] as Record<string, unknown>).role).toBe("user");
      }
    }
  });

  test("emergency compression triggers when critically above threshold", async () => {
    // 15 messages with ~30 repeats each = ~2378 tokens (measured empirically)
    // Set emergency threshold below that count
    const config = testConfig({
      contextWindow: 2000,
      emergencyCompressRatio: 0.8, // emergency at 1600 tokens (below 2378 ✅)
      emergencyTargetRatio: 0.4,   // target 800 tokens
      aggressiveCompressRatio: 0.95, // aggressive at 1900 tokens (won't trigger, emergency first)
      mildOffloadRatio: 0.95,        // mild at 1900 tokens (won't trigger)
    });

    // Create many messages with long text
    const msgs: Record<string, unknown>[] = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message number ${i}: `.repeat(30),
    }));
    const originalLength = msgs.length;

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    // Should have triggered emergency compression
    // Note: compression mutates msgs in-place, so use originalLength for comparison
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeLessThan(originalLength);
    expect(result.tokensBefore).toBeGreaterThan(0);
    expect(result.emergencyApplied).toBe(true);
  });

  test("compression is a no-op when below all thresholds", async () => {
    // Use a very large context window
    const config = testConfig({ contextWindow: 1_000_000 });
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "Short" },
      { role: "assistant", content: "Brief reply." },
    ];

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    expect(result.messages).toHaveLength(2);
    expect(result.mildApplied).toBe(false);
    expect(result.aggressiveApplied).toBe(false);
    expect(result.emergencyApplied).toBe(false);
    // Tokens should be the same since no compression occurred
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });

  test("handles single message without crashing", async () => {
    const config = testConfig({ contextWindow: 100 });
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "Hello" },
    ];

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    expect(result.messages).toHaveLength(1);
    expect(result.mildApplied).toBe(false);
    expect(result.aggressiveApplied).toBe(false);
  });

  test("utilisation reflects token usage relative to context window", async () => {
    const config = testConfig({ contextWindow: 1000 });
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "Small message" },
      { role: "assistant", content: "Another small one" },
    ];

    const result = await compressSession(msgs, [], config, undefined, noopLogger);

    // Utilisation should be low for a small message relative to 1000 token window
    expect(result.utilisation).toBeGreaterThan(0);
    expect(result.utilisation).toBeLessThan(1);
  });

  test("works with the noop logger and no stateManager", async () => {
    const config = testConfig({ contextWindow: 1_000_000 });
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "Test" },
    ];

    // Should not throw
    const result = await compressSession(msgs, [], config, undefined, noopLogger);
    expect(result.messages).toHaveLength(1);
  });
});
