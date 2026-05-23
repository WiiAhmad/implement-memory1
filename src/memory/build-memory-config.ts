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
      enableDedup: true,
      maxMemoriesPerSession: 20,
    },
    persona: {
      triggerEveryN: 50,
      maxScenes: 20,   // Match library default; 150 caused oversized scene nav
      backupCount: 3,
      sceneBackupCount: 10,
    },
    pipeline: {
      everyNConversations: 10,
      enableWarmup: true,
      l1IdleTimeoutSeconds: 600,   // 5 min (default: 600); aggressive idle triggers wasted L1 runs
      l2DelayAfterL1Seconds: 5,
      l2MinIntervalSeconds: 900,
      l2MaxIntervalSeconds: 3600,
      sessionActiveWindowHours: 24,
    },
    recall: {
      enabled: true,
      maxResults: 5,
      scoreThreshold: 0.3,
      strategy: "keyword",           // embedding is disabled below — hybrid would silently fall back to keyword
      timeoutMs: 5000,
    },
    embedding: {
      enabled: false,
      provider: "none",              // was "openai" but disabled — confusing; "none" skips all embedding init
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
