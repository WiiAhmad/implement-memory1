// ═══════════════════════════════════════════════════════════════════════
//  [Step 20]  OFFLOAD TYPES — Configuration & Re-exports for Offload Module
//  ═══════════════════════════════════════════════════════════════════════
//  Defines the OffloadConfig type (parsed from env vars) and re-exports
//  types from the TencentDB-Agent-Memory library's offload module.
//  All default values match PLUGIN_DEFAULTS from the library.
// ═══════════════════════════════════════════════════════════════════════

// ─── Step 20a: Re-exports from the TDAI library ───────────────────────

export type {
  OffloadEntry,
  PluginConfig,
  ToolPair,
  PluginLogger,
} from "../../TencentDB-Agent-Memory/src/offload/types.ts";

export { PLUGIN_DEFAULTS } from "../../TencentDB-Agent-Memory/src/offload/types.ts";

export type {
  StorageContext,
} from "../../TencentDB-Agent-Memory/src/offload/storage.ts";

// ─── Step 20b: Bot-level OffloadConfig ────────────────────────────────
//  Controls all layers of the offload context compression system.
//  Parsed from OFFLOAD_* environment variables in src/config/env.ts.

export interface OffloadConfig {
  /** Master switch — when false, all offload operations are no-ops. */
  enabled: boolean;

  /** LLM model to use for L1/L1.5/L2 calls. Falls back to main chat model. */
  model?: string;

  /** LLM execution mode for library-compatible config. */
  mode: "local" | "backend";

  /** LLM temperature for offload tasks (default: 0.2). */
  temperature: number;

  /** Force-trigger L1 when pending tool pairs reaches this threshold. */
  forceTriggerThreshold: number;

  /** Model context window size (default: 128000 for GPT-4o). */
  contextWindow: number;

  /** Maximum tool pairs sent to one L1/L2 batch. */
  maxPairsPerBatch: number;

  /** L1 tool pair summarization (default: false). */
  l1Enabled: boolean;

  /** L1.5 task boundary detection (default: false). */
  l15Enabled: boolean;

  /** L2 MMD generation (default: false). */
  l2Enabled: boolean;

  /** Data retention in days (0 = disabled, min effective: 3). */
  offloadRetentionDays: number;

  /** Max total debug log size in MB before reclaim truncates logs. */
  logMaxSizeMb: number;

  /** Optional backend service URL for library-compatible config. */
  backendUrl?: string;

  /** Optional backend auth token for library-compatible config. */
  backendApiKey?: string;

  /** Backend call timeout in milliseconds. */
  backendTimeoutMs: number;

  /** User identifier for backend offload persistence. */
  userId?: string;

  // ─── Compression Threshold Ratios ────────────────────────────────

  /** Token utilisation ratio that triggers mild compression (default: 0.85). */
  mildOffloadRatio: number;

  /** Token utilisation ratio that triggers aggressive compression (default: 0.85). */
  aggressiveCompressRatio: number;

  /** Token utilisation ratio that triggers emergency compression (default: 0.95). */
  emergencyCompressRatio: number;

  /** Target token utilisation after emergency compression (default: 0.6). */
  emergencyTargetRatio: number;

  /** Fraction of oldest messages to delete per aggressive round (default: 0.4). */
  aggressiveDeleteRatio: number;

  /** Fraction of messages to scan for mild compression candidates (default: 0.7). */
  mildOffloadScanRatio: number;

  /** Max fraction of context window for MMD injection (default: 0.2). */
  mmdMaxTokenRatio: number;

  // ─── L2 Scheduling ───────────────────────────────────────────────

  /** Minimum null-score entries before L2 triggers (default: 4). */
  l2NullThreshold: number;

  /** Seconds since last L2 before a new check runs (default: 300). */
  l2TimeoutSeconds: number;
}

// ─── Step 20c: Default values for all OffloadConfig fields ────────────
export const DEFAULT_OFFLOAD_CONFIG: OffloadConfig = {
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

  // Compression threshold ratios (matching PLUGIN_DEFAULTS)
  mildOffloadRatio: 0.85,
  aggressiveCompressRatio: 0.85,
  emergencyCompressRatio: 0.95,
  emergencyTargetRatio: 0.6,
  aggressiveDeleteRatio: 0.4,
  mildOffloadScanRatio: 0.7,
  mmdMaxTokenRatio: 0.2,

  // L2 scheduling
  l2NullThreshold: 4,
  l2TimeoutSeconds: 300,
};
