import type { AppEnv } from "../config/env.ts";

export function buildMemorySessionKey(telegramUserId: number | string): string {
  return `tg:user:${telegramUserId}`;
}

export function buildTdaiRawConfig(env: AppEnv): Record<string, unknown> {
  return {
    storeBackend: "sqlite",
    capture: {
      enabled: true,
    },
    extraction: {
      enabled: true,
      enableDedup: false,
      maxMemoriesPerSession: 100,
    },
    persona: {
      triggerEveryN: 50,
      maxScenes: 150,
      backupCount: 3,
      sceneBackupCount: 10,
    },
    pipeline: {
      everyNConversations: 10,
      enableWarmup: true,
      l1IdleTimeoutSeconds: 60,
      l2DelayAfterL1Seconds: 5,
      l2MinIntervalSeconds: 900,
      l2MaxIntervalSeconds: 3600,
      sessionActiveWindowHours: 24,
    },
    recall: {
      enabled: true,
      maxResults: 5,
      strategy: "hybrid",
      timeoutMs: 5000,
    },
    embedding: {
      enabled: false,
      provider: "openai",
      baseUrl: env.embedding.baseUrl,
      apiKey: env.embedding.apiKey,
      model: env.embedding.model,
      dimensions: env.embedding.dimensions,
    },
    bm25: {
      enabled: true,
      language: "en",
    },
  };
}
