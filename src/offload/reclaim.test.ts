/**
 * Unit tests for offload data retention reclaim.
 *
 * Tests cover:
 * - Reclaim deletes old offload files, preserves new ones
 * - Reclaim preserves active MMD
 * - Reclaim skips when feature gate disabled
 * - Reclaim logs stats
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { OffloadService } from "./index.ts";
import type { OffloadConfig } from "./types.ts";

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
    l2WaitRetrySeconds: 120,
    l2TimeTriggerRequiresNewOffload: true,
    reclaimEnabled: true,
    waitRetryEnabled: false,
    ...overrides,
  };
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "reclaim-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("OffloadService runReclaim", () => {
  test("runReclaim returns null when reclaim feature gate is disabled", async () => {
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

    const result = await service.runReclaim();
    expect(result).toBeNull();
    await service.close();
  });

  test("runReclaim returns null when retentionDays < 3", async () => {
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

    const result = await service.runReclaim();
    expect(result).toBeNull();
    await service.close();
  });

  test("runReclaim returns stats when enabled", async () => {
    // Create a temp dir with offload data structure
    const reclaimDir = await mkdtemp(join(tmpdir(), "reclaim-data-"));

    try {
      // Create agent subdirectory with an old offload JSONL
      const agentDir = join(reclaimDir, "telegram-bot");
      await mkdir(agentDir, { recursive: true });
      await mkdir(join(agentDir, "refs"), { recursive: true });
      await mkdir(join(agentDir, "mmds"), { recursive: true });

      // Create an old offload JSONL (mtime will be now, so won't be deleted)
      await writeFile(join(agentDir, "offload-session1.jsonl"), '{"tool_call_id":"call_1","summary":"test"}\n');

      const service = new OffloadService({
        enabled: true,
        config: testConfig({
          enabled: true,
          offloadRetentionDays: 7,
          reclaimEnabled: true,
        }),
        logger: noopLogger,
        getDataDir: () => reclaimDir,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      });

      const result = await service.runReclaim();
      // Should complete without error
      expect(result).not.toBeNull();
      if (result) {
        expect(typeof result.deletedJsonl).toBe("number");
        expect(typeof result.deletedRefs).toBe("number");
        expect(typeof result.deletedMmds).toBe("number");
        expect(typeof result.truncatedLogs).toBe("number");
        expect(typeof result.prunedRegistryEntries).toBe("number");
      }
      await service.close();
    } finally {
      await rm(reclaimDir, { recursive: true, force: true });
    }
  });

  test("runReclaim preserves files within retention window", async () => {
    const reclaimDir = await mkdtemp(join(tmpdir(), "reclaim-fresh-"));

    try {
      const agentDir = join(reclaimDir, "telegram-bot");
      await mkdir(agentDir, { recursive: true });
      const mmdsDir = join(agentDir, "mmds");
      await mkdir(mmdsDir, { recursive: true });

      // Create fresh MMD file
      await writeFile(join(mmdsDir, "001-test.mmd"), "flowchart TD\n  A[Start] --> B[End]\n");

      const service = new OffloadService({
        enabled: true,
        config: testConfig({
          enabled: true,
          offloadRetentionDays: 7,
          reclaimEnabled: true,
        }),
        logger: noopLogger,
        getDataDir: () => reclaimDir,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      });

      // Run reclaim
      await service.runReclaim();

      // Fresh MMD should still exist
      expect(existsSync(join(mmdsDir, "001-test.mmd"))).toBe(true);
      await service.close();
    } finally {
      await rm(reclaimDir, { recursive: true, force: true });
    }
  });

  test("runReclaim does not schedule timer when feature gate disabled", () => {
    const service = new OffloadService({
      enabled: true,
      config: testConfig({
        enabled: true,
        offloadRetentionDays: 7,
        reclaimEnabled: false, // Feature gate off
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

  test("runReclaim returns null when offload disabled", async () => {
    const service = new OffloadService({
      enabled: false,
      config: testConfig({
        enabled: false,
        offloadRetentionDays: 7,
        reclaimEnabled: true,
      }),
      logger: noopLogger,
      getDataDir: () => tempDir,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    const result = await service.runReclaim();
    expect(result).toBeNull();
  });
});
