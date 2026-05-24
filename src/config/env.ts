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
  OFFLOAD_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  OFFLOAD_CONTEXT_WINDOW: z.coerce.number().int().positive().default(128_000),
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
    temperature: number;
    contextWindow: number;
    l1Enabled: boolean;
    l15Enabled: boolean;
    l2Enabled: boolean;
    offloadRetentionDays: number;
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
      temperature: parsed.OFFLOAD_TEMPERATURE,
      contextWindow: parsed.OFFLOAD_CONTEXT_WINDOW,
      l1Enabled: parsed.OFFLOAD_L1_ENABLED,
      l15Enabled: parsed.OFFLOAD_L15_ENABLED,
      l2Enabled: parsed.OFFLOAD_L2_ENABLED,
      offloadRetentionDays: parsed.OFFLOAD_RETENTION_DAYS,
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
