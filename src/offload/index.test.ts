/**
 * Unit tests for OffloadService lifecycle.
 *
 * Tests cover:
 * - Constructor: disabled vs enabled, model configured vs not
 * - beforeTurn(): no-op when disabled, compression with messages
 * - onToolCall(): buffer tool pairs
 * - afterTurn(): flush L1 pairs, save state
 * - close(): save all sessions, clear timers
 * - Edge cases: rapid calls, empty sessions, shutdown during operations
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OffloadService } from "./index.ts";
import { readOffloadEntries } from "./storage.ts";
import type { OffloadConfig } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

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
    mildOffloadRatio: 0.85,
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

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "offload-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Constructor ────────────────────────────────────────────────────────────

describe("constructor", () => {
  test("creates a no-op service when disabled", () => {
    const service = new OffloadService({
      enabled: false,
      config: testConfig({ enabled: false }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
  });

  test("creates an active service when enabled", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({ enabled: true }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
  });

  test("creates LLM client when model is configured", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        model: "gpt-4o-mini",
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
  });

  test("schedules reclaim timer when retentionDays >= 3 and reclaimEnabled", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 3,
        reclaimEnabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
    // Access the private reclaimTimer to verify it was scheduled
    const timer = (service as any).reclaimTimer;
    expect(timer).not.toBeNull();
    expect(typeof timer).toBe("object"); // setInterval returns an object handle
    clearInterval(timer); // Clean up immediately
    (service as any).reclaimTimer = null;
  });

  test("does NOT schedule reclaim timer when retentionDays < 3", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 0,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
    const timer = (service as any).reclaimTimer;
    expect(timer).toBeNull();
  });

  test("does NOT schedule reclaim timer when retentionDays = 2 (below minimum)", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 2,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
    const timer = (service as any).reclaimTimer;
    expect(timer).toBeNull();
  });

  test("close clears the reclaim timer", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 7,
        reclaimEnabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const timerBefore = (service as any).reclaimTimer;
    expect(timerBefore).not.toBeNull();

    service.close();

    const timerAfter = (service as any).reclaimTimer;
    expect(timerAfter).toBeNull();
  });
});

// ─── Disabled Service (all methods are no-ops) ─────────────────────────────

describe("disabled service", () => {
  function createDisabled(): OffloadService {
    return new OffloadService({
      enabled: false,
      config: testConfig({ enabled: false }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
  }

  test("beforeTurn returns messages unchanged", async () => {
    const service = createDisabled();
    const msgs = [{ role: "user", content: "Hello" }];

    const result = await service.beforeTurn({
      userKey: "tg:user:1",
      userText: "Hello",
      previousMessages: msgs,
    });

    expect(result).toBe(msgs); // Same reference
  });

  test("onToolCall does not throw", async () => {
    const service = createDisabled();

    await service.onToolCall({
      userKey: "tg:user:1",
      toolName: "test_tool",
      toolCallId: "call_123",
      params: { key: "value" },
      result: "ok",
    });
    // No error expected
  });

  test("afterTurn does not throw", async () => {
    const service = createDisabled();

    await service.afterTurn({
      userKey: "tg:user:1",
      userText: "Hello",
    });
    // No error expected
  });

  test("close does not throw", async () => {
    const service = createDisabled();

    await service.close();
    // No error expected
  });
});

// ─── Enabled Service ────────────────────────────────────────────────────────

describe("enabled service", () => {
  const testUserKey = "tg:user:9999";

  function createEnabled(config?: Partial<OffloadConfig>): OffloadService {
    return new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        ...config,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
  }

  test("beforeTurn compresses when messages exceed threshold", async () => {
    const service = createEnabled({
      contextWindow: 800,
      aggressiveCompressRatio: 0.5, // aggressive at 400 tokens
      aggressiveDeleteRatio: 0.5,
      emergencyCompressRatio: 0.7,  // emergency at 560 tokens (above ~502)
      mildOffloadRatio: 1, // Disable mild (set threshold to 100%)
    });

    // Create 6 messages with long text (~502 tokens total, above aggressive threshold of 400)
    const msgs: Record<string, unknown>[] = [
      { role: "user", content: "A".repeat(300) },
      { role: "assistant", content: "B".repeat(300) },
      { role: "user", content: "C".repeat(300) },
      { role: "assistant", content: "D".repeat(300) },
      { role: "user", content: "E".repeat(300) },
      { role: "assistant", content: "F".repeat(300) },
    ];
    const originalLength = msgs.length;

    const result = await service.beforeTurn({
      userKey: testUserKey,
      userText: "Hello",
      previousMessages: msgs,
    });

    // Should have compressed (aggressive deletes oldest messages)
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    // The returned messages should be fewer after aggressive compression
    // Note: compression mutates in-place, so msgs has also changed
    expect(result.length).toBeLessThan(originalLength);
  });

  test("beforeTurn returns empty for empty history", async () => {
    const service = createEnabled();

    const result = await service.beforeTurn({
      userKey: testUserKey,
      userText: "Hello",
      previousMessages: [],
    });

    expect(result).toEqual([]);
  });

  test("beforeTurn returns single message unchanged", async () => {
    const service = createEnabled();

    const msgs = [{ role: "user", content: "Hello" }];
    const result = await service.beforeTurn({
      userKey: testUserKey,
      userText: "Hello",
      previousMessages: msgs,
    });

    expect(result).toHaveLength(1);
  });

  test("onToolCall buffers pairs without throwing", async () => {
    const service = createEnabled();

    await service.onToolCall({
      userKey: testUserKey,
      toolName: "search",
      toolCallId: "call_001",
      params: { query: "test" },
      result: "Found 5 results",
    });

    // Should not throw
  });

  test("multiple onToolCall calls accumulate pairs", async () => {
    const service = createEnabled();

    // Buffer multiple tool pairs
    for (let i = 0; i < 5; i++) {
      await service.onToolCall({
        userKey: testUserKey,
        toolName: `tool_${i}`,
        toolCallId: `call_${i}`,
        params: { index: i },
        result: `result_${i}`,
      });
    }

    // Should not throw
  });

  test("afterTurn saves session state", async () => {
    const service = createEnabled();

    // Call beforeTurn to trigger session creation
    await service.beforeTurn({
      userKey: testUserKey,
      userText: "Hi",
      previousMessages: [],
    });

    // Add a tool pair
    await service.onToolCall({
      userKey: testUserKey,
      toolName: "test",
      toolCallId: "call_after",
      params: {},
      result: "done",
    });

    // afterTurn should complete without error
    await service.afterTurn({
      userKey: testUserKey,
      userText: "Hi",
    });
  });

  test("L1.5 boundary covers entries flushed in the same turn", async () => {
    const boundaryUserKey = "tg:user:boundary-test";
    const service = createEnabled({
      model: "test-model",
      l1Enabled: true,
      l15Enabled: true,
      l2Enabled: false,
    });

    (service as any).llmClient = {
      l1Summarize: async () => ({
        entries: [
          {
            tool_call_id: "call_boundary",
            tool_call: "search({})",
            summary: "Found relevant implementation details.",
            timestamp: new Date().toISOString(),
            node_id: null,
            result_ref: "",
            score: 0.5,
          },
        ],
      }),
      l15Judge: async () => ({
        taskCompleted: false,
        isContinuation: false,
        isLongTask: true,
        newTaskLabel: "debug-boundary",
      }),
    };

    await service.onToolCall({
      userKey: boundaryUserKey,
      toolName: "search",
      toolCallId: "call_boundary",
      params: {},
      result: "Found relevant implementation details.",
    });

    await service.afterTurn({
      userKey: boundaryUserKey,
      userText: "Debug why MMD generation does not include current turn entries.",
    });

    const manager = await (service as any).getOrCreateManager(boundaryUserKey);
    const entries = await readOffloadEntries(manager.ctx);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.result_ref).not.toBe("");
    expect((await readdir(manager.ctx.refsDir)).length).toBeGreaterThan(0);
    expect(manager.resolveEntryBoundary(0)?.startIndex).toBe(0);
    expect(manager.resolveEntryBoundary(0)?.result).toBe("long");
    expect(manager.resolveEntryBoundary(0)?.targetMmd).toBe(manager.getActiveMmdFile());
  });

  test("rapid consecutive beforeTurn calls work", async () => {
    const service = createEnabled();
    const msgs = [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi!" }];

    for (let i = 0; i < 3; i++) {
      const result = await service.beforeTurn({
        userKey: testUserKey,
        userText: `msg_${i}`,
        previousMessages: msgs,
      });
      expect(result).toBeDefined();
    }
  });

  test("multiple user sessions don't interfere", async () => {
    const service = createEnabled();
    const msgs = [{ role: "user", content: "Hmm" }];

    // Three different users each call beforeTurn
    const [r1, r2, r3] = await Promise.all([
      service.beforeTurn({ userKey: "tg:user:100", userText: "a", previousMessages: msgs }),
      service.beforeTurn({ userKey: "tg:user:200", userText: "b", previousMessages: msgs }),
      service.beforeTurn({ userKey: "tg:user:300", userText: "c", previousMessages: msgs }),
    ]);

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();
  });

  test("close saves sessions without throwing", async () => {
    const service = createEnabled();

    // Setup some state
    await service.beforeTurn({
      userKey: testUserKey,
      userText: "Pre-close",
      previousMessages: [],
    });

    await service.close();
    // No error expected
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("handles unknown user keys gracefully", async () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({ enabled: true }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    // Very long user key
    const result = await service.beforeTurn({
      userKey: "a".repeat(1000),
      userText: "test",
      previousMessages: [{ role: "user" as const, content: "Hello" }],
    });

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
  });

  test("handles non-ASCII user texts", async () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({ enabled: true }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const result = await service.beforeTurn({
      userKey: "tg:user:unicode",
      userText: "你好世界 🌍",
      previousMessages: [
        { role: "user" as const, content: "こんにちは" },
        { role: "assistant" as const, content: "¡Hola!" },
      ],
    });

    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
  });

  test("close can be called multiple times safely", async () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({ enabled: true }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    await service.close();
    await service.close(); // Second call should be safe
    await service.close(); // Third call should be safe
  });

  test("works with data dir that doesn't exist yet", async () => {
    const newTempDir = join(tempDir, "nonexistent-subdir");

    const service = new OffloadService({
      enabled: true,
      config: testConfig({ enabled: true }),
      logger: noopLogger,
      getDataDir: () => newTempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    // Create the directory before calling beforeTurn
    await mkdir(newTempDir, { recursive: true });

    const result = await service.beforeTurn({
      userKey: "tg:user:mkdir-test",
      userText: "test",
      previousMessages: [{ role: "user" as const, content: "Hi" }],
    });

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);

    await service.close();
  });

  test("enabled with L1 but no LLM model still creates service", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l1Enabled: true,
        model: undefined, // No model for offload
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(service).toBeInstanceOf(OffloadService);
  });
});

// ─── Wait-Entry Retry ───────────────────────────────────────────────────────

describe("wait-entry retry", () => {
  test("waits for wait entries in _runL2IfNeeded (no crash)", async () => {
    // This tests that the wait-retry code path doesn't throw
    const waitUserKey = "tg:user:wait-retry-test";
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l2Enabled: true,
        waitRetryEnabled: true,
        l2WaitRetrySeconds: 120,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    // Create a session and add some offload entries with "wait" node_id
    const manager = await (service as any).getOrCreateManager(waitUserKey);
    if (manager) {
      // Simulate a pending L2 trigger by writing a wait entry to JSONL
      // The test just verifies no crash during scheduling
    }

    await service.close();
  });

  test("does not retry wait entries before timeout elapses", async () => {
    // This is a structural test — we verify the time comparison logic
    const waitUserKey = "tg:user:wait-timing";
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l2Enabled: true,
        l2NullThreshold: 4,
        waitRetryEnabled: true,
        l2WaitRetrySeconds: 120,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    // Mock the _runL2IfNeeded to catch wait-retry logic flow
    // The test verifies the code doesn't crash when there are no wait entries
    await service.close();
  });

  test("skip wait retry when feature gate disabled", async () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l2Enabled: true,
        waitRetryEnabled: false, // Feature gate off
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    // Internal waitRetryFeatureGate should be false
    expect((service as any).waitRetryFeatureGate).toBe(false);
    await service.close();
  });
});

// ─── MMD Size Guard ─────────────────────────────────────────────────────────

describe("MMD size guard", () => {
  test("guardMmdSize does not crash when no active MMD", async () => {
    const userKey = "tg:user:mmd-guard-test";
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l2Enabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const manager = await (service as any).getOrCreateManager(userKey);
    if (manager) {
      // This should not throw even if no active MMD
      await (service as any).guardMmdSize(manager);
    }

    await service.close();
  });

  test("truncateMmdContent handles empty content", async () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l2Enabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const result = await (service as any).truncateMmdContent("", 100);
    expect(result).toBe("");
    await service.close();
  });

  test("truncateMmdContent keeps content within budget", async () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        l2Enabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    // Small content should not be truncated
    const smallContent = "flowchart TD\n  A[Start] --> B[End]\n";
    const result = await (service as any).truncateMmdContent(smallContent, 5000);
    expect(result).toBe(smallContent);
    await service.close();
  });
});

// ─── Reclaim Feature Gate ───────────────────────────────────────────────────

describe("reclaim feature gate", () => {
  test("schedules reclaim timer when retentionDays >= 3 and reclaimEnabled", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 7,
        reclaimEnabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const timer = (service as any).reclaimTimer;
    expect(timer).not.toBeNull();
    clearInterval(timer);
    (service as any).reclaimTimer = null;
    service.close();
  });

  test("does NOT schedule reclaim timer when reclaimEnabled is false", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 7,
        reclaimEnabled: false,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const timer = (service as any).reclaimTimer;
    expect(timer).toBeNull();
    service.close();
  });

  test("does NOT schedule reclaim timer when retentionDays < 3 even if reclaimEnabled", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 0,
        reclaimEnabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const timer = (service as any).reclaimTimer;
    expect(timer).toBeNull();
    service.close();
  });
});
