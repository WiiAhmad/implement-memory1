#!/usr/bin/env bun
/**
 * Offload performance benchmark (9.8).
 *
 * Measures per-turn latency of key offload operations:
 * - beforeTurn() with varying history sizes
 * - compressSession() across compression tiers
 * - estimateMessageTokens() throughput
 * - onToolCall() buffering
 * - afterTurn() state persistence
 *
 * Run:  bun scripts/offload-benchmark.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OffloadService } from "../src/offload/index.ts";
import { compressSession, configureL3TokenTracker, normalizeMessages, denormalizeMessages } from "../src/offload/compressor.ts";
import { estimateMessageTokens } from "../src/offload/compressor.ts";
import type { OffloadConfig, OffloadEntry } from "../src/offload/types.ts";

// ─── Configuration ──────────────────────────────────────────────────────────

const WARMUP_RUNS = 3;
const BENCH_RUNS = 10;

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function config(overrides?: Partial<OffloadConfig>): OffloadConfig {
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

function makeMessages(count: number, textLen: number = 200): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `[Message ${i}] ${"X".repeat(textLen)}`,
    });
  }
  return msgs;
}

/** Format a duration in ms with color. */
function fmt(ms: number): string {
  const label = ms < 1 ? `${(ms * 1000).toFixed(1)}μs` :
               ms < 1000 ? `${ms.toFixed(2)}ms` :
               `${(ms / 1000).toFixed(2)}s`;
  return ms > 100 ? `\x1b[31m${label}\x1b[0m` :  // Red for slow
         ms > 10 ? `\x1b[33m${label}\x1b[0m` :    // Yellow for medium
         `\x1b[32m${label}\x1b[0m`;                // Green for fast
}

/** Benchmark a function, returning the average duration in ms. */
async function bench(label: string, fn: () => Promise<void> | void, runs: number = BENCH_RUNS): Promise<number> {
  // Warmup
  for (let i = 0; i < WARMUP_RUNS; i++) await fn();

  // Measurement
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  process.stdout.write(`  ${label.padEnd(40)} ${fmt(avg).padEnd(14)} (min=${fmt(min)}, max=${fmt(max)})\n`);
  return avg;
}

// ─── Ensure token tracker is configured ─────────────────────────────────────

configureL3TokenTracker();

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "offload-bench-"));
  const service = new OffloadService({
    enabled: true,
    config: config(),
    logger: noopLogger,
    getDataDir: () => tempDir,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-bench",
  });

  console.log("\n\x1b[1m═══ Offload Performance Benchmark ═══\x1b[0m\n");

  // ── 1. Token Estimation ────────────────────────────────────────────────

  console.log("\x1b[1m1. Token Estimation\x1b[0m");

  const smallMsgs = makeMessages(5, 100);
  const largeMsgs = makeMessages(50, 500);

  await bench("5 messages × 100 chars", () => {
    estimateMessageTokens("bench", smallMsgs, null, null);
  });

  await bench("50 messages × 500 chars", () => {
    estimateMessageTokens("bench", largeMsgs, null, null);
  });

  await bench("50 messages × 500 chars (with system prompt)", () => {
    estimateMessageTokens("bench", largeMsgs, "You are a helpful assistant. ".repeat(50), null);
  });

  // ── 2. beforeTurn() with varying history ───────────────────────────────

  console.log("\n\x1b[1m2. beforeTurn() — Small History (under threshold, no compression)\x1b[0m");

  const msg5 = makeMessages(5, 100);
  await bench("5 messages", async () => {
    await service.beforeTurn({
      userKey: "tg:user:bench",
      userText: "Hello",
      previousMessages: msg5,
    });
  });

  console.log("\n\x1b[1m3. beforeTurn() — Large History (aggressive compression)\x1b[0m");

  const localConfig = config({
    contextWindow: 2000,
    aggressiveCompressRatio: 0.3,
    emergencyCompressRatio: 0.9,
    mildOffloadRatio: 1,
  });

  // Re-create service with aggressive settings
  await service.close();
  const service2 = new OffloadService({
    enabled: true,
    config: localConfig,
    logger: noopLogger,
    getDataDir: () => tempDir,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-bench",
  });

  const msg50 = makeMessages(50, 300);

  await bench("50 messages × 300 chars (above aggressive threshold)", async () => {
    await service2.beforeTurn({
      userKey: "tg:user:bench",
      userText: "Compress this",
      previousMessages: [...msg50],
    });
  });

  await service2.close();

  // ── 3. compressSession() Direct ────────────────────────────────────────

  console.log("\n\x1b[1m4. compressSession() Direct — No L1 Entries (mild no-op)\x1b[0m");

  const cfg = config({
    contextWindow: 2000,
    aggressiveCompressRatio: 0.3,
    emergencyCompressRatio: 0.9,
    mildOffloadRatio: 1,
  });

  await bench("50 msgs, empty offloadMap (no mild)", async () => {
    await compressSession([...msg50], [], cfg);
  });

  console.log("\n\x1b[1m5. compressSession() Direct — With L1 Entries (mild possible)\x1b[0m");

  // Create synthetic L1 entries
  const l1Entries: OffloadEntry[] = msg50
    .filter((m: any) => m.role === "assistant")
    .slice(0, 10)
    .map((m: any, i: number) => ({
      tool_call_id: `bench_call_${i}`,
      tool_call: `bench_tool(${JSON.stringify({ index: i })})`,
      summary: `Summary of tool result ${i}: query executed successfully with ${i * 10} results`,
      timestamp: new Date().toISOString(),
      node_id: null as string | null,
      result_ref: "",
      score: 5,
    }));

  // Create messages with matching tool call IDs
  const msgsWithTools: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    msgsWithTools.push({ role: "user", content: `Question ${i}` });
    msgsWithTools.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `bench_call_${i}`, function: { name: `bench_tool`, arguments: `{"index":${i}}` } }],
    } as any);
    msgsWithTools.push({ role: "tool", content: `Result ${i} with ${i*10} matches`, tool_call_id: `bench_call_${i}` });
  }

  await bench("30 msgs (10 tool cycles), 10 L1 entries", async () => {
    await compressSession([...msgsWithTools], l1Entries, config({
      contextWindow: 5000,
      mildOffloadRatio: 0.3,
      mildOffloadScanRatio: 1.0,
    }));
  });

  // ── 4. Message Format Normalization ────────────────────────────────────

  console.log("\n\x1b[1m6. Message Format Normalization\x1b[0m");

  const normMsgs = msgsWithTools;
  await bench("normalizeMessages (30 msgs w/ tool_calls)", () => {
    const restore = normalizeMessages(normMsgs);
    denormalizeMessages(normMsgs, restore);
  });

  // ── 5. onToolCall Buffering ────────────────────────────────────────────

  console.log("\n\x1b[1m7. onToolCall() Buffering\x1b[0m");

  const service3 = new OffloadService({
    enabled: true,
    config: config(),
    logger: noopLogger,
    getDataDir: () => tempDir,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-bench",
  });

  // First call to create session
  await service3.beforeTurn({
    userKey: "tg:user:bench2",
    userText: "init",
    previousMessages: [{ role: "user" as const, content: "init" }],
  });

  await bench("onToolCall (single pair)", async () => {
    await service3.onToolCall({
      userKey: "tg:user:bench2",
      toolName: "search",
      toolCallId: "call_bench",
      params: { query: "test" },
      result: "ok",
    });
  });

  await bench("onToolCall × 10 in sequence", async () => {
    for (let i = 0; i < 10; i++) {
      await service3.onToolCall({
        userKey: "tg:user:bench2",
        toolName: "tool_" + i,
        toolCallId: "call_b_" + i,
        params: { i },
        result: "r" + i,
      });
    }
  });

  // ── 6. afterTurn() State Persistence ────────────────────────────────────

  console.log("\n\x1b[1m8. afterTurn() State Persistence\x1b[0m");

  await bench("afterTurn (save state)", async () => {
    await service3.afterTurn({
      userKey: "tg:user:bench2",
      userText: "Done",
    });
  });

  // ── 7. Normalization Round-trip ─────────────────────────────────────────

  console.log("\n\x1b[1m9. Full Lifecycle Round-trip (10 turns × 3 tool calls each)\x1b[0m");

  const service4 = new OffloadService({
    enabled: true,
    config: config(),
    logger: noopLogger,
    getDataDir: () => tempDir,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-bench",
  });

  await bench("10 turns × 3 tool calls each", async () => {
    for (let turn = 0; turn < 10; turn++) {
      await service4.beforeTurn({
        userKey: "tg:user:bench3",
        userText: `Turn ${turn}`,
        previousMessages: makeMessages(2 + turn, 50),
      });
      for (let tc = 0; tc < 3; tc++) {
        await service4.onToolCall({
          userKey: "tg:user:bench3",
          toolName: "search",
          toolCallId: `call_t${turn}_${tc}`,
          params: { index: tc },
          result: `result_${tc}`,
        });
      }
      await service4.afterTurn({
        userKey: "tg:user:bench3",
        userText: `Turn ${turn}`,
      });
    }
  });

  await service4.close();

  // ── Summary ────────────────────────────────────────────────────────────

  console.log("\n\x1b[1m═══ Results Summary ═══\x1b[0m");
  console.log("  All times are averages over", BENCH_RUNS, "runs (after", WARMUP_RUNS, "warmup runs).");
  console.log("  Green = fast (<10ms), Yellow = medium (10-100ms), Red = slow (>100ms)\n");

  // ── Cleanup ────────────────────────────────────────────────────────────

  rmSync(tempDir, { recursive: true, force: true });
}

main().catch(console.error);
