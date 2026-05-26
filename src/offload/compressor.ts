// ═══════════════════════════════════════════════════════════════════════
//  [Step 24]  L3 COMPRESSION ORCHESTRATOR — Context Window Management
//  ═══════════════════════════════════════════════════════════════════════
//  Wraps the TDAI library's L3 compression algorithms to manage conversation
//  context within the LLM's context window.
//
//  Compression Tiers (applied in order of severity):
//    1. Emergency:  Last-resort deletion when critically over threshold (95%)
//       → History MMD injection replaces deleted content
//    2. Aggressive: Delete oldest messages when over threshold (85%)
//       → History MMD injection replaces deleted content
//    3. Mild:       Replace tool result messages with L1 summaries (85%)
//
//  Also handles message format normalization between OpenAI format
//  (tool_calls array) and the TDAI library format (tool_use blocks).
// ═══════════════════════════════════════════════════════════════════════

import { configureTokenTracker, buildTiktokenContextSnapshot } from "../../TencentDB-Agent-Memory/src/offload/context-token-tracker.ts";
import type { ContextSnapshot } from "../../TencentDB-Agent-Memory/src/offload/context-token-tracker.ts";
import { createL3TokenCounter } from "../../TencentDB-Agent-Memory/src/offload/l3-token-counter.ts";
import { populateOffloadLookupMap } from "../../TencentDB-Agent-Memory/src/offload/l3-helpers.ts";
import type { OffloadEntry, PluginLogger } from "./types.ts";
import type { OffloadConfig } from "./types.ts";
import { PLUGIN_DEFAULTS } from "./types.ts";

import {
  compressByScoreCascade,
  aggressiveCompressUntilBelowThreshold,
  emergencyCompress,
  buildHistoryMmdInjection,
  removeExistingMmdInjections,
  filterHeartbeatMessages,
  isTokenOverflowError,
} from "../../TencentDB-Agent-Memory/src/offload/hooks/llm-input-l3.ts";

import { findHistoryMmdInsertionPoint } from "../../TencentDB-Agent-Memory/src/offload/mmd-injector.ts";

import type { PluginConfig } from "../../TencentDB-Agent-Memory/src/offload/types.ts";
import type { OffloadStateManager } from "../../TencentDB-Agent-Memory/src/offload/state-manager.ts";

// ─── Step 24a: Token Tracker Initialization (runs once at startup) ────
let _tokenTrackerConfigured = false;

export function configureL3TokenTracker(): void {
  if (_tokenTrackerConfigured) return;
  configureTokenTracker("o200k_base");
  _tokenTrackerConfigured = true;
}

// ─── Step 24b: Message Format Normalization (OpenAI → Library Format) ──
//  Converts assistant messages with tool_calls array to content array
//  with tool_use blocks (as expected by the TDAI compressor).
//  Returns a restore array that denormalizeMessages() uses to revert.
export function normalizeMessages(
  messages: unknown[],
): Array<{
  index: number;
  originalContent: unknown;
  originalToolCalls: unknown;
  hadToolCalls: boolean;
}> {
  const restore: Array<{
    index: number;
    originalContent: unknown;
    originalToolCalls: unknown;
    hadToolCalls: boolean;
  }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;

    // 1. Tool result messages: alias tool_call_id → toolCallId
    if (msg.role === "tool") {
      if (!msg.toolCallId && msg.tool_call_id) {
        (msg as Record<string, unknown>).toolCallId = msg.tool_call_id;
      }
    }

    // 2. Assistant messages with tool_calls: convert to content array
    const toolCalls = msg.tool_calls;
    if (
      msg.role === "assistant" &&
      Array.isArray(toolCalls) &&
      toolCalls.length > 0 &&
      typeof msg.content === "string"
    ) {
      const originalContent = msg.content;
      const originalToolCalls = structuredClone(toolCalls);
      const blocks: Array<Record<string, unknown>> = [];

      if (originalContent) {
        blocks.push({ type: "text", text: originalContent });
      }

      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: fn?.name as string,
          input: fn?.arguments as string,
        });
      }

      delete msg.tool_calls;
      msg.content = blocks;

      restore.push({ index: i, originalContent, originalToolCalls, hadToolCalls: true });
    }
  }

  return restore;
}

// ─── Step 24c: Restore messages to OpenAI format ───────────────────────
export function denormalizeMessages(
  messages: unknown[],
  restore: Array<{
    index: number;
    originalContent: unknown;
    originalToolCalls: unknown;
    hadToolCalls: boolean;
  }>,
): void {
  for (const item of restore) {
    if (!item.hadToolCalls || item.index >= messages.length) continue;
    const msg = messages[item.index] as Record<string, unknown>;
    msg.content = item.originalContent;
    if (item.originalToolCalls) {
      (msg as Record<string, unknown>).tool_calls = item.originalToolCalls;
    }
  }
}

// ─── Step 24d: Token estimation helpers ───────────────────────────────
export function estimateMessageTokens(
  stage: string,
  messages: unknown[],
  systemPromptText: string | null,
  userPromptText: string | null,
): number {
  const snap = buildTiktokenContextSnapshot(stage, messages, systemPromptText, userPromptText);
  return snap.totalTokens;
}

export function buildContextSnapshot(
  stage: string,
  messages: unknown[],
  systemPromptText: string | null,
  userPromptText: string | null,
): ContextSnapshot {
  return buildTiktokenContextSnapshot(stage, messages, systemPromptText, userPromptText);
}

// ─── Step 24e: No-op logger for safe defaulting ───────────────────────
const NOOP_LOGGER: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Step 24f: Compression Result Type ────────────────────────────────
export interface CompressionResult {
  messages: unknown[];
  tokensAfter: number;
  tokensBefore: number;
  mildApplied: boolean;
  mildReplacedCount: number;
  aggressiveApplied: boolean;
  aggressiveDeletedCount: number;
  emergencyApplied: boolean;
  emergencyDeletedCount: number;
  utilisation: number; // 0-1 ratio of tokens used vs context window
}

// ─── Step 24g: Main Compression Orchestrator ───────────────────────────
//  Applies compression tiers in order of severity:
//  1. Emergency (if above emergencyCompressRatio)
//  2. Aggressive (if above aggressiveCompressRatio)
//  3. Mild (if above mildOffloadRatio and offload entries exist)
//
//  Each tier runs independently — if emergency fires, aggressive and mild
//  are skipped (emergency compresses below all thresholds).
export async function compressSession(
  messages: unknown[],
  offloadEntries: OffloadEntry[],
  config: OffloadConfig,
  stateManager?: OffloadStateManager,
  logger?: PluginLogger,
): Promise<CompressionResult> {
  if (!messages || messages.length === 0) {
    return {
      messages, tokensAfter: 0, tokensBefore: 0,
      mildApplied: false, mildReplacedCount: 0,
      aggressiveApplied: false, aggressiveDeletedCount: 0,
      emergencyApplied: false, emergencyDeletedCount: 0,
      utilisation: 0,
    };
  }

  // 1. Normalize messages to library format
  const restore = normalizeMessages(messages);

  // 2. Build offload lookup map (for mild compression)
  const offloadMap = new Map<string, OffloadEntry>();
  populateOffloadLookupMap(offloadMap, offloadEntries);

  // 3. Estimate current token usage and thresholds
  const contextWindow = config.contextWindow;
  const snap = buildTiktokenContextSnapshot("l3_before_turn", messages, null, null);
  const tokensBefore = snap.totalTokens;
  const mildThreshold = Math.floor(contextWindow * (config.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio));
  const aggressiveThreshold = Math.floor(contextWindow * (config.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio));
  const emergencyThreshold = Math.floor(contextWindow * (config.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio));

  let workingTokens = tokensBefore;
  let mildApplied = false, mildReplacedCount = 0;
  let aggressiveApplied = false, aggressiveDeletedCount = 0;
  let emergencyApplied = false, emergencyDeletedCount = 0;

  const effectiveLogger = logger ?? NOOP_LOGGER;
  const countTokens = createL3TokenCounter(undefined, effectiveLogger);

  // 4. Emergency compression (last resort)
  if (workingTokens >= emergencyThreshold && messages.length > 4) {
    const tierStartedAt = Date.now();
    emergencyApplied = true;
    const emergencyTarget = Math.floor(contextWindow * (config.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio));
    const result = emergencyCompress(messages as any[], emergencyTarget, countTokens, null, null, effectiveLogger);
    emergencyDeletedCount = result.deletedCount;
    workingTokens = result.remainingTokens;

    // Build history MMD injection for deleted content
    if (stateManager && result.deletedToolCallIds.length > 0) {
      try {
        const mmdResult = await buildHistoryMmdInjection(
          result.deletedToolCallIds, offloadMap, offloadEntries,
          stateManager, effectiveLogger, countTokens, contextWindow,
          toPluginConfig(config),
        );
        if (mmdResult.injectedMessages.length > 0) {
          removeExistingMmdInjections(messages as any[]);
          const histInsertIdx = findHistoryMmdInsertionPoint(messages as any[]);
          (messages as any[]).splice(histInsertIdx, 0, ...mmdResult.injectedMessages);
        }
      } catch (mmdErr) {
        effectiveLogger.warn(`[offload] EMERGENCY: history MMD injection failed: ${mmdErr}`);
      }
    }

    denormalizeMessages(messages, restore);
    return finalizeResult(messages, tokensBefore, workingTokens, contextWindow, {
      mildApplied: false, mildReplacedCount: 0,
      aggressiveApplied: false, aggressiveDeletedCount: 0,
      emergencyApplied: true, emergencyDeletedCount,
    });
  }

  // 5. Aggressive compression (delete oldest messages)
  if (workingTokens >= aggressiveThreshold && messages.length > 2) {
    aggressiveApplied = true;
    const aggressiveDeleteRatio = config.aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;
    const result = await aggressiveCompressUntilBelowThreshold(
      messages as any[], offloadMap, new Set<string>(),
      aggressiveDeleteRatio, stateManager ?? ({} as OffloadStateManager),
      effectiveLogger, aggressiveThreshold, countTokens, null, null,
    );
    aggressiveDeletedCount = result.deletedCount;

    const afterAggressive = buildTiktokenContextSnapshot("l3_after_aggressive", messages, null, null);
    workingTokens = afterAggressive.totalTokens;

    // History MMD injection
    if (stateManager && result.allDeletedToolCallIds.length > 0) {
      try {
        const mmdResult = await buildHistoryMmdInjection(
          result.allDeletedToolCallIds, offloadMap, offloadEntries,
          stateManager, effectiveLogger, countTokens, contextWindow,
          toPluginConfig(config),
        );
        if (mmdResult.injectedMessages.length > 0) {
          removeExistingMmdInjections(messages as any[]);
          const histInsertIdx = findHistoryMmdInsertionPoint(messages as any[]);
          (messages as any[]).splice(histInsertIdx, 0, ...mmdResult.injectedMessages);
          const afterMmd = buildTiktokenContextSnapshot("l3_after_aggressive_mmd", messages, null, null);
          workingTokens = afterMmd.totalTokens;
        }
      } catch (mmdErr) {
        effectiveLogger.warn(`[offload] AGGRESSIVE: history MMD injection failed: ${mmdErr}`);
      }
    }
  }

  // 6. Mild compression (replace tool results with L1 summaries)
  if (workingTokens >= mildThreshold && offloadMap.size > 0) {
    const mildScanRatio = config.mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;
    mildApplied = true;
    const cascadeResult = compressByScoreCascade(messages as any[], offloadMap, new Set<string>(), mildScanRatio, effectiveLogger);
    mildReplacedCount = cascadeResult.replacedCount;
  }

  // 7. Restore messages and finalize
  denormalizeMessages(messages, restore);
  const finalSnap = buildTiktokenContextSnapshot("l3_final", messages, null, null);
  const tokensAfter = finalSnap.totalTokens;

  return finalizeResult(messages, tokensBefore, tokensAfter, contextWindow, {
    mildApplied, mildReplacedCount,
    aggressiveApplied, aggressiveDeletedCount,
    emergencyApplied, emergencyDeletedCount,
  });
}

// ─── Step 24h: Build final CompressionResult ───────────────────────────
function finalizeResult(messages: unknown[], tokensBefore: number, tokensAfter: number, contextWindow: number, flags: {
  mildApplied: boolean; mildReplacedCount: number;
  aggressiveApplied: boolean; aggressiveDeletedCount: number;
  emergencyApplied: boolean; emergencyDeletedCount: number;
}): CompressionResult {
  return {
    messages, tokensAfter, tokensBefore,
    mildApplied: flags.mildApplied, mildReplacedCount: flags.mildReplacedCount,
    aggressiveApplied: flags.aggressiveApplied, aggressiveDeletedCount: flags.aggressiveDeletedCount,
    emergencyApplied: flags.emergencyApplied, emergencyDeletedCount: flags.emergencyDeletedCount,
    utilisation: contextWindow > 0 ? tokensAfter / contextWindow : 0,
  };
}

// ─── Step 24i: Config conversion ──────────────────────────────────────
function toPluginConfig(config: OffloadConfig): Partial<PluginConfig> {
  return {
    model: config.model, temperature: config.temperature,
    forceTriggerThreshold: config.forceTriggerThreshold,
    maxPairsPerBatch: config.maxPairsPerBatch,
    l2NullThreshold: config.l2NullThreshold,
    l2TimeoutSeconds: config.l2TimeoutSeconds,
    mildOffloadRatio: config.mildOffloadRatio,
    aggressiveCompressRatio: config.aggressiveCompressRatio,
    emergencyCompressRatio: config.emergencyCompressRatio,
    emergencyTargetRatio: config.emergencyTargetRatio,
    aggressiveDeleteRatio: config.aggressiveDeleteRatio,
    mildOffloadScanRatio: config.mildOffloadScanRatio,
    mmdMaxTokenRatio: config.mmdMaxTokenRatio,
    defaultContextWindow: config.contextWindow,
  };
}

// ─── Step 24j: Re-exports ─────────────────────────────────────────────
export { isTokenOverflowError, filterHeartbeatMessages };

// ─── Step 24k: Legacy normalization (toolCallId alias only) ────────────
export function normalizeToolResultMessages(messages: unknown[]): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "tool" && !m.toolCallId && m.tool_call_id) {
      (m as Record<string, unknown>).toolCallId = m.tool_call_id;
    }
  }
}
