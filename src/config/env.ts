import { z } from "zod";

const EnvSchema = z.object({
  // ── Core ────────────────────────────────────────────────────────────────
  BOT_TOKEN: z.string().min(1),
  MEMORY_AGENT: z.string().min(1).default("data"),
  PROVIDER: z.literal("openai"),
  OPENAI_API_KEY: z.string().min(1),
  BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  MODEL: z.string().min(1),
  EMBEDDING_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive(),

  // ── Memory (TDAI) Config ────────────────────────────────────────────────
  // Store
  MEMORY_STORE_BACKEND: z.enum(["sqlite"]).default("sqlite"),

  // Capture
  MEMORY_CAPTURE_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  MEMORY_L0L1_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  MEMORY_ALLOW_AGGRESSIVE_CLEANUP: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  MEMORY_CLEAN_TIME: z.string().default("03:00"),

  // Extraction
  MEMORY_EXTRACTION_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  MEMORY_EXTRACTION_DEDUP: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  MEMORY_MAX_MEMORIES: z.coerce.number().int().positive().default(20),

  // Persona
  MEMORY_PERSONA_TRIGGER_N: z.coerce.number().int().positive().default(50),
  // Matches library default; 150 caused oversized scene navigation
  MEMORY_PERSONA_MAX_SCENES: z.coerce.number().int().positive().default(20),
  MEMORY_PERSONA_BACKUP_COUNT: z.coerce.number().int().min(0).default(3),
  MEMORY_PERSONA_SCENE_BACKUP: z.coerce.number().int().min(0).default(10),

  // Pipeline
  MEMORY_PIPELINE_EVERY_N: z.coerce.number().int().positive().default(10),
  MEMORY_PIPELINE_WARMUP: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // 5 min (default: 600); aggressive idle triggers wasted L1 runs
  MEMORY_L1_IDLE_TIMEOUT: z.coerce.number().int().positive().default(600),
  MEMORY_L2_DELAY_AFTER_L1: z.coerce.number().int().min(0).default(5),
  MEMORY_L2_MIN_INTERVAL: z.coerce.number().int().positive().default(900),
  MEMORY_L2_MAX_INTERVAL: z.coerce.number().int().positive().default(3600),
  MEMORY_SESSION_WINDOW_HOURS: z.coerce.number().int().positive().default(24),

  // Recall
  MEMORY_RECALL_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  MEMORY_RECALL_MAX_RESULTS: z.coerce.number().int().positive().default(5),
  MEMORY_RECALL_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  // Embedding is disabled below — hybrid would silently fall back to keyword
  MEMORY_RECALL_STRATEGY: z.enum(["keyword"]).default("keyword"),
  MEMORY_RECALL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Embedding
  MEMORY_EMBEDDING_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Was "openai" but disabled — "none" skips all embedding init
  MEMORY_EMBEDDING_PROVIDER: z.string().default("none"),

  // BM25
  MEMORY_BM25_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  MEMORY_BM25_LANGUAGE: z.string().default("en"),

  // ── Offload Module Config ───────────────────────────────────────────────
  OFFLOAD_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  OFFLOAD_MODEL: z.string().optional(),
  OFFLOAD_MODE: z.enum(["local", "backend"]).default("local"),
  OFFLOAD_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  OFFLOAD_FORCE_TRIGGER_THRESHOLD: z.coerce.number().int().positive().default(4),
  OFFLOAD_CONTEXT_WINDOW: z.coerce.number().int().positive().default(128_000),
  OFFLOAD_MAX_PAIRS_PER_BATCH: z.coerce.number().int().positive().default(20),
  OFFLOAD_L1_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  OFFLOAD_L15_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  OFFLOAD_L2_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  OFFLOAD_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  OFFLOAD_LOG_MAX_SIZE_MB: z.coerce.number().int().min(0).default(50),
  OFFLOAD_BACKEND_URL: z.union([z.string().url(), z.literal("")]).optional(),
  OFFLOAD_BACKEND_API_KEY: z.string().optional(),
  OFFLOAD_BACKEND_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  OFFLOAD_USER_ID: z.string().optional(),

  OFFLOAD_MILD_RATIO: z.coerce.number().min(0).max(1).default(0.85),
  OFFLOAD_AGGRESSIVE_RATIO: z.coerce.number().min(0).max(1).default(0.85),
  OFFLOAD_EMERGENCY_RATIO: z.coerce.number().min(0).max(1).default(0.95),
  OFFLOAD_EMERGENCY_TARGET_RATIO: z.coerce.number().min(0).max(1).default(0.6),
  OFFLOAD_AGGRESSIVE_DELETE_RATIO: z.coerce.number().min(0).max(1).default(0.4),
  OFFLOAD_MILD_SCAN_RATIO: z.coerce.number().min(0).max(1).default(0.7),
  OFFLOAD_MMD_MAX_TOKEN_RATIO: z.coerce.number().min(0).max(1).default(0.2),

  OFFLOAD_L2_NULL_THRESHOLD: z.coerce.number().int().min(0).default(4),
  OFFLOAD_L2_TIMEOUT_SECONDS: z.coerce.number().int().min(0).default(300),
});

export interface AppEnv {
  botToken: string;
  memoryRoot: string;
  provider: "openai";
  openAIApiKey: string;
  baseUrl: string;
  model: string;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };

  /** TDAI memory configuration. */
  memory: {
    storeBackend: string;
    captureEnabled: boolean;
    l0l1RetentionDays: number;
    allowAggressiveCleanup: boolean;
    cleanTime: string;
    extractionEnabled: boolean;
    extractionDedup: boolean;
    maxMemoriesPerSession: number;
    personaTriggerEveryN: number;
    personaMaxScenes: number;
    personaBackupCount: number;
    personaSceneBackupCount: number;
    pipelineEveryNConversations: number;
    pipelineWarmup: boolean;
    l1IdleTimeoutSeconds: number;
    l2DelayAfterL1Seconds: number;
    l2MinIntervalSeconds: number;
    l2MaxIntervalSeconds: number;
    sessionActiveWindowHours: number;
    recallEnabled: boolean;
    recallMaxResults: number;
    recallScoreThreshold: number;
    recallStrategy: string;
    recallTimeoutMs: number;
    embeddingEnabled: boolean;
    embeddingProvider: string;
    bm25Enabled: boolean;
    bm25Language: string;
  };

  /** Offload module configuration. */
  offload: {
    enabled: boolean;
    model?: string;
    mode: "local" | "backend";
    temperature: number;
    forceTriggerThreshold: number;
    contextWindow: number;
    maxPairsPerBatch: number;
    l1Enabled: boolean;
    l15Enabled: boolean;
    l2Enabled: boolean;
    offloadRetentionDays: number;
    logMaxSizeMb: number;
    backendUrl?: string;
    backendApiKey?: string;
    backendTimeoutMs: number;
    userId?: string;
    mildOffloadRatio: number;
    aggressiveCompressRatio: number;
    emergencyCompressRatio: number;
    emergencyTargetRatio: number;
    aggressiveDeleteRatio: number;
    mildOffloadScanRatio: number;
    mmdMaxTokenRatio: number;
    l2NullThreshold: number;
    l2TimeoutSeconds: number;
  };
}

export function parseEnv(input: Record<string, string | undefined>): AppEnv {
  const parsed = EnvSchema.parse(input);

  return {
    botToken: parsed.BOT_TOKEN,
    memoryRoot: parsed.MEMORY_AGENT,
    provider: parsed.PROVIDER,
    openAIApiKey: parsed.OPENAI_API_KEY,
    baseUrl: parsed.BASE_URL,
    model: parsed.MODEL,
    embedding: {
      baseUrl: parsed.EMBEDDING_BASE_URL,
      apiKey: parsed.EMBEDDING_API_KEY,
      model: parsed.EMBEDDING_MODEL,
      dimensions: parsed.EMBEDDING_DIMENSIONS,
    },

    memory: {
      storeBackend: parsed.MEMORY_STORE_BACKEND,
      captureEnabled: parsed.MEMORY_CAPTURE_ENABLED,
      l0l1RetentionDays: parsed.MEMORY_L0L1_RETENTION_DAYS,
      allowAggressiveCleanup: parsed.MEMORY_ALLOW_AGGRESSIVE_CLEANUP,
      cleanTime: parsed.MEMORY_CLEAN_TIME,
      extractionEnabled: parsed.MEMORY_EXTRACTION_ENABLED,
      extractionDedup: parsed.MEMORY_EXTRACTION_DEDUP,
      maxMemoriesPerSession: parsed.MEMORY_MAX_MEMORIES,
      personaTriggerEveryN: parsed.MEMORY_PERSONA_TRIGGER_N,
      personaMaxScenes: parsed.MEMORY_PERSONA_MAX_SCENES,
      personaBackupCount: parsed.MEMORY_PERSONA_BACKUP_COUNT,
      personaSceneBackupCount: parsed.MEMORY_PERSONA_SCENE_BACKUP,
      pipelineEveryNConversations: parsed.MEMORY_PIPELINE_EVERY_N,
      pipelineWarmup: parsed.MEMORY_PIPELINE_WARMUP,
      l1IdleTimeoutSeconds: parsed.MEMORY_L1_IDLE_TIMEOUT,
      l2DelayAfterL1Seconds: parsed.MEMORY_L2_DELAY_AFTER_L1,
      l2MinIntervalSeconds: parsed.MEMORY_L2_MIN_INTERVAL,
      l2MaxIntervalSeconds: parsed.MEMORY_L2_MAX_INTERVAL,
      sessionActiveWindowHours: parsed.MEMORY_SESSION_WINDOW_HOURS,
      recallEnabled: parsed.MEMORY_RECALL_ENABLED,
      recallMaxResults: parsed.MEMORY_RECALL_MAX_RESULTS,
      recallScoreThreshold: parsed.MEMORY_RECALL_SCORE_THRESHOLD,
      recallStrategy: parsed.MEMORY_RECALL_STRATEGY,
      recallTimeoutMs: parsed.MEMORY_RECALL_TIMEOUT_MS,
      embeddingEnabled: parsed.MEMORY_EMBEDDING_ENABLED,
      embeddingProvider: parsed.MEMORY_EMBEDDING_PROVIDER,
      bm25Enabled: parsed.MEMORY_BM25_ENABLED,
      bm25Language: parsed.MEMORY_BM25_LANGUAGE,
    },

    offload: {
      enabled: parsed.OFFLOAD_ENABLED,
      model: parsed.OFFLOAD_MODEL || undefined,
      mode: parsed.OFFLOAD_MODE,
      temperature: parsed.OFFLOAD_TEMPERATURE,
      forceTriggerThreshold: parsed.OFFLOAD_FORCE_TRIGGER_THRESHOLD,
      contextWindow: parsed.OFFLOAD_CONTEXT_WINDOW,
      maxPairsPerBatch: parsed.OFFLOAD_MAX_PAIRS_PER_BATCH,
      l1Enabled: parsed.OFFLOAD_L1_ENABLED,
      l15Enabled: parsed.OFFLOAD_L15_ENABLED,
      l2Enabled: parsed.OFFLOAD_L2_ENABLED,
      offloadRetentionDays: parsed.OFFLOAD_RETENTION_DAYS,
      logMaxSizeMb: parsed.OFFLOAD_LOG_MAX_SIZE_MB,
      backendUrl: parsed.OFFLOAD_BACKEND_URL || undefined,
      backendApiKey: parsed.OFFLOAD_BACKEND_API_KEY || undefined,
      backendTimeoutMs: parsed.OFFLOAD_BACKEND_TIMEOUT_MS,
      userId: parsed.OFFLOAD_USER_ID || undefined,
      mildOffloadRatio: parsed.OFFLOAD_MILD_RATIO,
      aggressiveCompressRatio: parsed.OFFLOAD_AGGRESSIVE_RATIO,
      emergencyCompressRatio: parsed.OFFLOAD_EMERGENCY_RATIO,
      emergencyTargetRatio: parsed.OFFLOAD_EMERGENCY_TARGET_RATIO,
      aggressiveDeleteRatio: parsed.OFFLOAD_AGGRESSIVE_DELETE_RATIO,
      mildOffloadScanRatio: parsed.OFFLOAD_MILD_SCAN_RATIO,
      mmdMaxTokenRatio: parsed.OFFLOAD_MMD_MAX_TOKEN_RATIO,
      l2NullThreshold: parsed.OFFLOAD_L2_NULL_THRESHOLD,
      l2TimeoutSeconds: parsed.OFFLOAD_L2_TIMEOUT_SECONDS,
    },
  };
}
