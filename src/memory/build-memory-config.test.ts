import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env.ts";
import { buildMemorySessionKey, buildTdaiRawConfig } from "./build-memory-config.ts";

const env: AppEnv = {
  botToken: "123456:telegram-token",
  memoryRoot: "data",
  provider: "openai",
  openAIApiKey: "sk-chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  embedding: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-embed",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  memory: {
    storeBackend: "sqlite",
    captureEnabled: true,
    l0l1RetentionDays: 0,
    allowAggressiveCleanup: false,
    cleanTime: "03:00",
    extractionEnabled: true,
    extractionDedup: true,
    maxMemoriesPerSession: 20,
    personaTriggerEveryN: 50,
    personaMaxScenes: 20,
    personaBackupCount: 3,
    personaSceneBackupCount: 10,
    sceneExtractionTimeoutMs: 300_000,
    pipelineEveryNConversations: 10,
    pipelineWarmup: true,
    l1IdleTimeoutSeconds: 600,
    l2DelayAfterL1Seconds: 5,
    l2MinIntervalSeconds: 900,
    l2MaxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
    recallEnabled: true,
    recallMaxResults: 5,
    recallScoreThreshold: 0.3,
    recallStrategy: "keyword",
    recallTimeoutMs: 5000,
    embeddingEnabled: false,
    embeddingProvider: "none",
    bm25Enabled: true,
    bm25Language: "en",
  },
  offload: {
    enabled: false,
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
  },
};

describe("buildTdaiRawConfig", () => {
  test("maps OpenAI embedding env into the TencentDB schema shape", () => {
    const raw = buildTdaiRawConfig(env);

    expect(raw.storeBackend).toBe("sqlite");
    expect(raw.recall).toEqual({
      enabled: true,
      maxResults: 5,
      scoreThreshold: 0.3,
      strategy: "keyword",
      timeoutMs: 5000,
    });
    expect(raw.embedding).toEqual({
      enabled: false,
      provider: "none",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embed",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(raw.capture).toEqual({
      enabled: true,
      l0l1RetentionDays: 0,
      allowAggressiveCleanup: false,
      cleanTime: "03:00",
    });
    expect(raw.persona).toEqual({
      triggerEveryN: 50,
      maxScenes: 20,
      backupCount: 3,
      sceneBackupCount: 10,
      sceneExtractionTimeoutMs: 300_000,
    });
  });

  test("builds the stable Telegram memory session key", () => {
    expect(buildMemorySessionKey(42)).toBe("tg:user:42");
  });
});
