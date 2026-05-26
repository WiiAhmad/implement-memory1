import type { AppEnv } from "../config/env.ts";

export function buildMemorySessionKey(telegramUserId: number | string): string {
  return `tg:user:${telegramUserId}`;
}

export function buildTdaiRawConfig(env: AppEnv): Record<string, unknown> {
  return {
    storeBackend: env.memory.storeBackend,
    capture: {
      enabled: env.memory.captureEnabled,
      l0l1RetentionDays: env.memory.l0l1RetentionDays,
      allowAggressiveCleanup: env.memory.allowAggressiveCleanup,
      cleanTime: env.memory.cleanTime,
    },
    extraction: {
      enabled: env.memory.extractionEnabled,
      enableDedup: env.memory.extractionDedup,
      maxMemoriesPerSession: env.memory.maxMemoriesPerSession,
    },
    persona: {
      triggerEveryN: env.memory.personaTriggerEveryN,
      maxScenes: env.memory.personaMaxScenes,
      backupCount: env.memory.personaBackupCount,
      sceneBackupCount: env.memory.personaSceneBackupCount,
    },
    pipeline: {
      everyNConversations: env.memory.pipelineEveryNConversations,
      enableWarmup: env.memory.pipelineWarmup,
      l1IdleTimeoutSeconds: env.memory.l1IdleTimeoutSeconds,
      l2DelayAfterL1Seconds: env.memory.l2DelayAfterL1Seconds,
      l2MinIntervalSeconds: env.memory.l2MinIntervalSeconds,
      l2MaxIntervalSeconds: env.memory.l2MaxIntervalSeconds,
      sessionActiveWindowHours: env.memory.sessionActiveWindowHours,
    },
    recall: {
      enabled: env.memory.recallEnabled,
      maxResults: env.memory.recallMaxResults,
      scoreThreshold: env.memory.recallScoreThreshold,
      strategy: env.memory.recallStrategy,
      timeoutMs: env.memory.recallTimeoutMs,
    },
    embedding: {
      enabled: env.memory.embeddingEnabled,
      provider: env.memory.embeddingProvider,
      baseUrl: env.embedding.baseUrl,
      apiKey: env.embedding.apiKey,
      model: env.embedding.model,
      dimensions: env.embedding.dimensions,
    },
    bm25: {
      enabled: env.memory.bm25Enabled,
      language: env.memory.bm25Language,
    },
    offload: {
      enabled: env.offload.enabled,
      mode: env.offload.mode,
      model: env.offload.model,
      temperature: env.offload.temperature,
      forceTriggerThreshold: env.offload.forceTriggerThreshold,
      defaultContextWindow: env.offload.contextWindow,
      maxPairsPerBatch: env.offload.maxPairsPerBatch,
      l2NullThreshold: env.offload.l2NullThreshold,
      l2TimeoutSeconds: env.offload.l2TimeoutSeconds,
      mildOffloadRatio: env.offload.mildOffloadRatio,
      aggressiveCompressRatio: env.offload.aggressiveCompressRatio,
      mmdMaxTokenRatio: env.offload.mmdMaxTokenRatio,
      backendUrl: env.offload.backendUrl,
      backendApiKey: env.offload.backendApiKey,
      backendTimeoutMs: env.offload.backendTimeoutMs,
      offloadRetentionDays: env.offload.offloadRetentionDays,
      logMaxSizeMb: env.offload.logMaxSizeMb,
      userId: env.offload.userId,
    },
  };
}
