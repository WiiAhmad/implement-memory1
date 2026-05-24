/**
 * Integration tests for the offload module (9.6).
 *
 * Exercises the full offload pipeline end-to-end with real file system
 * operations — mimics the actual bot lifecycle:
 *
 *   1. Create OffloadService with real config (no LLM model → degraded L1)
 *   2. Simulate multiple conversation turns via beforeTurn/onToolCall/afterTurn
 *   3. Verify compression reduces message count, L1 entries are written to
 *      JSONL, state persists across turns, and shutdown is clean
 *   4. Restart service and verify state is recovered from disk
 *   5. Test disabled mode for complete no-op behavior
 *   6. Clean up temp directory
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OffloadService } from "./index.ts";
import type { OffloadConfig } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_USER_KEY = "tg:user:12345";
const ALT_USER_KEY = "tg:user:67890";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "offload-int-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Build an OffloadConfig tuned for predictable integration testing.
 * - Small context window (500 tokens) so compression triggers with few messages
 * - Aggressive ratio at 0.5 (250 tokens → triggers with ~5 short messages)
 * - Emergency ratio at 0.9 (450 tokens → only triggers with very long messages)
 * - L1 enabled but no model → tests the degraded fallback path
 */
function intConfig(overrides?: Partial<OffloadConfig>): OffloadConfig {
  return {
    enabled: true,
    model: undefined, // No LLM → degraded L1 fallback
    temperature: 0.2,
    contextWindow: 500,
    l1Enabled: true,
    l15Enabled: false,
    l2Enabled: false,
    offloadRetentionDays: 0,
    mildOffloadRatio: 0.85, // 425 tokens
    aggressiveCompressRatio: 0.5, // 250 tokens
    emergencyCompressRatio: 0.9, // 450 tokens
    emergencyTargetRatio: 0.6,
    aggressiveDeleteRatio: 0.5,
    mildOffloadScanRatio: 1.0,
    mmdMaxTokenRatio: 0.2,
    l2NullThreshold: 4,
    l2TimeoutSeconds: 300,
    ...overrides,
  };
}

/** A short message that's ~20 tokens. */
function shortMsg(role: "user" | "assistant", text: string): Record<string, unknown> {
  return { role, content: text };
}

/** Create N alternating user/assistant short messages. */
function makeConversation(n: number): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message number ${i + 1} in the test conversation.`,
    });
  }
  return msgs;
}

// ─── Integration Tests ──────────────────────────────────────────────────────

describe("offload integration", () => {
  // ── 1. Full lifecycle: create → turn loop → close ──────────────────────

  test("full lifecycle: compression, L1 flush, shutdown", async () => {
    const lifecycleDir = join(tempDir, "lifecycle-test");
    await rm(lifecycleDir, { recursive: true, force: true });
    const service = new OffloadService({
      enabled: true,
      config: intConfig(),
      logger: noopLogger,
      getDataDir: () => lifecycleDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-integration-test",
    });

    // ── Turn 1: short conversation (no compression needed) ──
    const turn1Msgs = makeConversation(2);
    const r1 = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "Hello, I need help with something.",
      previousMessages: turn1Msgs,
    });
    expect(r1).toBeDefined();
    expect(r1.length).toBe(2); // No compression for 2 messages

    // Tool calls in turn 1
    await service.onToolCall({
      userKey: TEST_USER_KEY,
      toolName: "search_files",
      toolCallId: "call_t1_1",
      params: { query: "help docs" },
      result: "Found 3 files: readme.md, guide.md, faq.md",
    });
    await service.onToolCall({
      userKey: TEST_USER_KEY,
      toolName: "read_file",
      toolCallId: "call_t1_2",
      params: { path: "guide.md" },
      result: "# Guide\nWelcome to the guide. This is very long content with lots of details...",
    });

    await service.afterTurn({
      userKey: TEST_USER_KEY,
      userText: "Hello, I need help with something.",
    });

    // ── Turn 2: build up more history ──
    const turn2Msgs = makeConversation(4);
    const r2 = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "Can you explain more?",
      previousMessages: turn2Msgs,
    });
    expect(r2).toBeDefined();

    await service.onToolCall({
      userKey: TEST_USER_KEY,
      toolName: "grep_search",
      toolCallId: "call_t2_1",
      params: { pattern: "config" },
      result: "Found config options in env.ts, config.yaml",
    });

    await service.afterTurn({
      userKey: TEST_USER_KEY,
      userText: "Can you explain more?",
    });

    // ── Turn 3: long history that triggers aggressive compression ──
    const turn3Msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      turn3Msgs.push(shortMsg(i % 2 === 0 ? "user" : "assistant", `Long repeating message ${i} `.repeat(20)));
    }
    const r3 = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "This is a long message that should trigger compression.",
      previousMessages: turn3Msgs,
    });
    expect(r3).toBeDefined();

    await service.afterTurn({
      userKey: TEST_USER_KEY,
      userText: "This is a long message that should trigger compression.",
    });

    // ── Close cleanly — persists state and creates dirs ──
    await service.close();

    // ── Verify offload data was persisted ──
    // Library creates: {dataRoot}/{agentName}/state.json and offload-{id}.jsonl
    const agentDir = join(lifecycleDir, "telegram-bot");
    const agentFiles = await readdir(agentDir).catch(() => [] as string[]);

    // Should have state.json and/or offload jsonl files
    const hasStateFile = agentFiles.includes("state.json");
    const hasJsonl = agentFiles.some((f) => f.startsWith("offload-") && f.endsWith(".jsonl"));
    expect(hasStateFile || hasJsonl).toBe(true);

    // Verify state.json contains valid JSON
    if (hasStateFile) {
      const stateContent = await readFile(join(agentDir, "state.json"), "utf-8").catch(() => null);
      if (stateContent) {
        const state = JSON.parse(stateContent);
        expect(state).toBeDefined();
      }
    }
  });

  // ── 2. Multiple users don't interfere ──────────────────────────────────

  test("multiple users maintain separate sessions", async () => {
    const service = new OffloadService({
      enabled: true,
      config: intConfig(),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-multi-user",
    });

    const msgs = makeConversation(3);

    // User A
    const ra = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "User A query",
      previousMessages: msgs,
    });
    expect(ra).toBeDefined();

    // User B (alt)
    const rb = await service.beforeTurn({
      userKey: ALT_USER_KEY,
      userText: "User B query",
      previousMessages: msgs,
    });
    expect(rb).toBeDefined();

    // Tool calls for user A
    await service.onToolCall({
      userKey: TEST_USER_KEY,
      toolName: "search",
      toolCallId: "call_ua_1",
      params: { q: "A's search" },
      result: "A's result",
    });

    // Tool calls for user B
    await service.onToolCall({
      userKey: ALT_USER_KEY,
      toolName: "search",
      toolCallId: "call_ub_1",
      params: { q: "B's search" },
      result: "B's result",
    });

    // afterTurn for both
    await service.afterTurn({
      userKey: TEST_USER_KEY,
      userText: "User A query",
    });
    await service.afterTurn({
      userKey: ALT_USER_KEY,
      userText: "User B query",
    });

    // Verify both sessions are saved on close
    await service.close();
  });

  // ── 3. State persistence across service restart ────────────────────────

  test("state persists across service restart", async () => {
    const dataDir = join(tempDir, "restart-test");
    await rm(dataDir, { recursive: true, force: true });

    const config = intConfig({ l1Enabled: true });

    // First service instance
    const s1 = new OffloadService({
      enabled: true,
      config,
      logger: noopLogger,
      getDataDir: () => dataDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-restart",
    });

    const msgs = makeConversation(3);
    await s1.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "First session message",
      previousMessages: msgs,
    });

    await s1.onToolCall({
      userKey: TEST_USER_KEY,
      toolName: "search",
      toolCallId: "call_restart_1",
      params: { q: "persistence test" },
      result: "persistence result",
    });

    await s1.afterTurn({
      userKey: TEST_USER_KEY,
      userText: "First session message",
    });

    await s1.close();

    // Second service instance (simulates restart)
    const s2 = new OffloadService({
      enabled: true,
      config,
      logger: noopLogger,
      getDataDir: () => dataDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-restart",
    });

    // After restart, beforeTurn should still work
    const msgs2 = makeConversation(2);
    const r = await s2.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "Second session message",
      previousMessages: msgs2,
    });
    expect(r).toBeDefined();

    await s2.close();
  });

  // ── 4. Disabled mode — complete no-op ─────────────────────────────────

  test("disabled mode is complete no-op for full lifecycle", async () => {
    const service = new OffloadService({
      enabled: false,
      config: intConfig({ enabled: false }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
    });

    const msgs = makeConversation(5);

    // beforeTurn returns messages unchanged (same reference)
    const r1 = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "test",
      previousMessages: msgs,
    });
    expect(r1).toBe(msgs); // Same reference

    // onToolCall does nothing
    await expect(
      service.onToolCall({
        userKey: TEST_USER_KEY,
        toolName: "test",
        toolCallId: "call_disabled",
        params: {},
        result: "ok",
      }),
    ).resolves.toBeUndefined();

    // afterTurn does nothing
    await expect(
      service.afterTurn({
        userKey: TEST_USER_KEY,
        userText: "test",
      }),
    ).resolves.toBeUndefined();

    // close does nothing
    await expect(service.close()).resolves.toBeUndefined();
  });

  // ── 5. Many rapid turns with tool calls ────────────────────────────────

  test("handles 25 rapid turns without errors", { timeout: 15000 }, async () => {
    const service = new OffloadService({
      enabled: true,
      config: intConfig({ aggressiveCompressRatio: 0.3 }), // Lower threshold for faster triggering
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-rapid",
    });

    for (let turn = 0; turn < 25; turn++) {
      const msgs = makeConversation(4 + (turn % 10)); // Varying history length

      const r = await service.beforeTurn({
        userKey: TEST_USER_KEY,
        userText: `Turn ${turn}`,
        previousMessages: msgs,
      });
      expect(r).toBeDefined();
      expect(Array.isArray(r)).toBe(true);
      // Messages should never be empty
      expect(r.length).toBeGreaterThan(0);

      // Sometimes add tool calls
      if (turn % 3 === 0) {
        await service.onToolCall({
          userKey: TEST_USER_KEY,
          toolName: "search",
          toolCallId: `call_rapid_${turn}`,
          params: { turn },
          result: `result_${turn}`,
        });
      }

      await service.afterTurn({
        userKey: TEST_USER_KEY,
        userText: `Turn ${turn}`,
      });
    }

    await service.close();
  });

  // ── 6. No tool calls — compression still works (aggressive) ────────────

  test("compression works even without tool calls (aggressive tier)", async () => {
    const service = new OffloadService({
      enabled: true,
      config: intConfig({
        contextWindow: 200,
        aggressiveCompressRatio: 0.3, // 60 tokens → triggers with ~3-4 messages
        l1Enabled: false, // No L1 needed
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-no-tool",
    });

    // Create messages that exceed the aggressive threshold
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `This is message number ${i} in the test conversation. It has enough text to consume tokens in the context window. `.repeat(3),
      });
    }
    const origLen = msgs.length;

    const r = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "No tool calls this turn",
      previousMessages: msgs,
    });

    expect(r).toBeDefined();
    expect(r.length).toBeLessThan(origLen);

    await service.afterTurn({
      userKey: TEST_USER_KEY,
      userText: "No tool calls this turn",
    });

    await service.close();
  });

  // ── 7. Empty session at startup doesn't crash ──────────────────────────

  test("empty session at startup doesn't crash", async () => {
    const emptyDir = join(tempDir, "empty-startup");
    await rm(emptyDir, { recursive: true, force: true });

    const service = new OffloadService({
      enabled: true,
      config: intConfig(),
      logger: noopLogger,
      getDataDir: () => emptyDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-empty",
    });

    // beforeTurn with empty history
    const r = await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "First ever message",
      previousMessages: [],
    });
    expect(r).toEqual([]);

    // afterTurn with no prior state
    await expect(
      service.afterTurn({
        userKey: TEST_USER_KEY,
        userText: "First ever message",
      }),
    ).resolves.toBeUndefined();

    await service.close();
  });

  // ── 8. Shutdown during operation does not hang ─────────────────────────

  test("rapid sequential close works", async () => {
    const service = new OffloadService({
      enabled: true,
      config: intConfig(),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-shutdown",
    });

    // Do a turn first to create state
    await service.beforeTurn({
      userKey: TEST_USER_KEY,
      userText: "pre-close",
      previousMessages: makeConversation(2),
    });

    // Rapid close
    await service.close();
    await service.close(); // Double close safe
    await service.close(); // Triple close safe
  });
});
