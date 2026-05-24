/**
 * L3 compression orchestrator for the offload module.
 *
 * Wraps the TencentDB-Agent-Memory library's L3 compression algorithms:
 * - Mild compression: replace tool result messages with L1 summaries
 * - Aggressive compression: delete oldest messages when above threshold
 * - Emergency compression: last-resort deletion when critically above threshold
 *
 * Also handles message format normalization between OpenAI format
 * (tool_calls array on assistant messages) and the library's expected
 * format (tool_use blocks in content array).
 */

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

// ─── Token Tracker Initialization ───────────────────────────────────────

let _tokenTrackerConfigured = false;

/**
 * Configure the tiktoken token tracker if not already configured.
 * Must be called once at startup before any compression runs.
 * Safe to call multiple times — only configures on first call.
 */
export function configureL3TokenTracker(): void {
  if (_tokenTrackerConfigured) return;
  configureTokenTracker("o200k_base");
  _tokenTrackerConfigured = true;
}

// ─── Message Normalization (OpenAI ↔ Library Format) ────────────────────

/**
 * Normalize messages from OpenAI format to the library's expected format.
 *
 * OpenAI format:
 *   - Assistant tool calls: `msg.tool_calls[i].id` (on msg level)
 *   - Tool results: `msg.role === "tool"`, `msg.tool_call_id`
 *
 * Library format:
 *   - Assistant tool use: `msg.content[i].type === "tool_use"`, `block.id`
 *   - Tool results: `msg.toolCallId` or `msg.tool_call_id`
 *
 * This function:
 * 1. Adds `toolCallId` alias on tool result messages (for extractToolCallId)
 * 2. Converts assistant messages with `tool_calls` to have a content array
 *    with `tool_use` blocks (for extractAllToolUseIds)
 *
 * Modifies messages in-place. Returns a restore array for denormalizeMessages().
 * The restore array stores the original content AND original tool_calls
 * so denormalize can faithfully restore both.
 */
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

    // 1. Tool result messages: alias tool_call_id → toolCallId (harmless, no denormalize needed)
    if (msg.role === "tool") {
      if (!msg.toolCallId && msg.tool_call_id) {
        (msg as Record<string, unknown>).toolCallId = msg.tool_call_id;
      }
    }

    // 2. Assistant messages with tool_calls: convert to content array with tool_use blocks
    //    Only do this if content is currently a string (OpenAI format)
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

      // Copy existing text content
      if (originalContent) {
        blocks.push({ type: "text", text: originalContent });
      }

      // Add tool_use blocks from tool_calls
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: fn?.name as string,
          input: fn?.arguments as string,
        });
      }

      // Delete tool_calls to match library format
      delete msg.tool_calls;
      msg.content = blocks;

      restore.push({ index: i, originalContent, originalToolCalls, hadToolCalls: true });
    }
  }

  return restore;
}

/**
 * Restore messages that were normalized back to their original format.
 * Only reverts messages that had tool_calls (hadToolCalls === true).
 */
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
    // Restore original content string
    msg.content = item.originalContent;
    // Restore original tool_calls (deep-cloned copy, no reference issues)
    if (item.originalToolCalls) {
      (msg as Record<string, unknown>).tool_calls = item.originalToolCalls;
    }
  }
}

// ─── Token Estimation ───────────────────────────────────────────────────

/**
 * Estimate the total token count for a set of messages.
 * Wraps buildTiktokenContextSnapshot() for token estimation.
 * Returns just the totalTokens value.
 */
export function estimateMessageTokens(
  stage: string,
  messages: unknown[],
  systemPromptText: string | null,
  userPromptText: string | null,
): number {
  const snap = buildTiktokenContextSnapshot(stage, messages, systemPromptText, userPromptText);
  return snap.totalTokens;
}

/**
 * Build a full context snapshot with detailed token breakdown.
 */
export function buildContextSnapshot(
  stage: string,
  messages: unknown[],
  systemPromptText: string | null,
  userPromptText: string | null,
): ContextSnapshot {
  return buildTiktokenContextSnapshot(stage, messages, systemPromptText, userPromptText);
}

// ─── No-op Logger for Safe Defaulting ───────────────────────────────────

const NOOP_LOGGER: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Compression Orchestrator ───────────────────────────────────────────

/**
 * Result of a compression session.
 */
export interface CompressionResult {
  /** The (possibly modified) messages array. */
  messages: unknown[];
  /** Total tokens after compression. */
  tokensAfter: number;
  /** Total tokens before compression. */
  tokensBefore: number;
  /** Whether mild compression was applied. */
  mildApplied: boolean;
  /** Number of mild replacements made. */
  mildReplacedCount: number;
  /** Whether aggressive compression was applied. */
  aggressiveApplied: boolean;
  /** Number of messages deleted by aggressive compression. */
  aggressiveDeletedCount: number;
  /** Whether emergency compression was applied. */
  emergencyApplied: boolean;
  /** Number of messages deleted by emergency compression. */
  emergencyDeletedCount: number;
  /** Context window utilisation after compression (0-1). */
  utilisation: number;
}

/**
 * Compress conversation messages using L3 algorithms.
 *
 * Applies compression tiers based on token thresholds:
 * - Below mildThreshold: no compression
 * - Above mildThreshold: mild compression (replace tool results with L1 summaries)
 * - Above aggressiveThreshold: aggressive compression (delete oldest messages)
 * - Above emergencyThreshold: emergency compression (last resort)
 *
 * @param messages - The conversation messages to compress (mutated in-place)
 * @param offloadEntries - L1 offload entries for mild compression (empty array = no mild)
 * @param config - Offload configuration
 * @param stateManager - Optional OffloadStateManager for aggressive/emergency state tracking
 * @param logger - Optional logger
 * @returns Compression result summary
 */
export async function compressSession(
  messages: unknown[],
  offloadEntries: OffloadEntry[],
  config: OffloadConfig,
  stateManager?: OffloadStateManager,
  logger?: PluginLogger,
): Promise<CompressionResult> {
  if (!messages || messages.length === 0) {
    return {
      messages,
      tokensAfter: 0,
      tokensBefore: 0,
      mildApplied: false,
      mildReplacedCount: 0,
      aggressiveApplied: false,
      aggressiveDeletedCount: 0,
      emergencyApplied: false,
      emergencyDeletedCount: 0,
      utilisation: 0,
    };
  }

  // 1. Normalize messages to library format (for mild compression compatibility)
  const restore = normalizeMessages(messages);

  // 2. Build offload lookup map (empty if no entries → mild is no-op)
  const offloadMap = new Map<string, OffloadEntry>();
  populateOffloadLookupMap(offloadMap, offloadEntries);

  // 3. Estimate current token usage
  const contextWindow = config.contextWindow;
  const snap = buildTiktokenContextSnapshot(
    "l3_before_turn",
    messages,
    null, // system prompt counted separately by caller
    null, // user prompt counted separately by caller
  );
  const tokensBefore = snap.totalTokens;
  const mildThreshold = Math.floor(
    contextWindow * (config.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio),
  );
  const aggressiveThreshold = Math.floor(
    contextWindow * (config.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio),
  );
  const emergencyThreshold = Math.floor(
    contextWindow * (config.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio),
  );

  let workingTokens = tokensBefore;
  let mildApplied = false;
  let mildReplacedCount = 0;
  let aggressiveApplied = false;
  let aggressiveDeletedCount = 0;
  let emergencyApplied = false;
  let emergencyDeletedCount = 0;

  const effectiveLogger = logger ?? NOOP_LOGGER;
  const countTokens = createL3TokenCounter(undefined, effectiveLogger);

  // 4. Emergency: last resort — early return since it compresses below any other threshold
  if (workingTokens >= emergencyThreshold && messages.length > 4) {
    const tierStartedAt = Date.now();
    emergencyApplied = true;
    const emergencyTarget = Math.floor(
      contextWindow * (config.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio),
    );
    const result = emergencyCompress(
      messages as any[],
      emergencyTarget,
      countTokens,
      null,
      null,
      effectiveLogger,
    );
    emergencyDeletedCount = result.deletedCount;
    workingTokens = result.remainingTokens;
    effectiveLogger.info(
      `[offload] EMERGENCY: deleted ${result.deletedCount} msgs, remaining≈${workingTokens} ` +
      `(target=${emergencyTarget}) [${Date.now() - tierStartedAt}ms]`,
    );

    // ── History MMD injection after emergency deletion ──
    if (stateManager && result.deletedToolCallIds.length > 0) {
      try {
        const mmdResult = await buildHistoryMmdInjection(
          result.deletedToolCallIds,
          offloadMap,
          offloadEntries,
          stateManager,
          effectiveLogger,
          countTokens,
          contextWindow,
          toPluginConfig(config),
        );
        if (mmdResult.injectedMessages.length > 0) {
          removeExistingMmdInjections(messages as any[]);
          const histInsertIdx = findHistoryMmdInsertionPoint(messages as any[]);
          (messages as any[]).splice(histInsertIdx, 0, ...mmdResult.injectedMessages);
          effectiveLogger.info(
            `[offload] EMERGENCY: injected ${mmdResult.injectedMessages.length} history MMD msg(s) at [${histInsertIdx}], ` +
            `tokens=${mmdResult.totalMmdTokens}, files=[${mmdResult.mmdFiles.join(",")}]`,
          );
        }
      } catch (mmdErr) {
        effectiveLogger.warn(`[offload] EMERGENCY: history MMD injection failed: ${mmdErr}`);
      }
    }

    // Restore messages and return — emergency targets 60%, well below other thresholds
    denormalizeMessages(messages, restore);
    return finalizeResult(messages, tokensBefore, workingTokens, contextWindow, {
      mildApplied: false, mildReplacedCount: 0,
      aggressiveApplied: false, aggressiveDeletedCount: 0,
      emergencyApplied: true, emergencyDeletedCount,
    });
  }

  // 5. Aggressive: delete oldest messages
  if (workingTokens >= aggressiveThreshold && messages.length > 2) {
    const tierStartedAt = Date.now();
    aggressiveApplied = true;
    const aggressiveDeleteRatio =
      config.aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;

    const result = await aggressiveCompressUntilBelowThreshold(
      messages as any[],
      offloadMap,
      new Set<string>(),
      aggressiveDeleteRatio,
      stateManager ?? ({} as OffloadStateManager),
      effectiveLogger,
      aggressiveThreshold,
      countTokens,
      null,
      null,
    );
    aggressiveDeletedCount = result.deletedCount;
    effectiveLogger.info(
      `[offload] AGGRESSIVE: deleted ${result.deletedCount} msgs over ${result.rounds} rounds, ` +
      `remaining≈${result.remainingTokens} [${Date.now() - tierStartedAt}ms]`,
    );

    // Update working tokens using a fresh snapshot after aggressive deletion
    const afterAggressive = buildTiktokenContextSnapshot(
      "l3_after_aggressive",
      messages,
      null,
      null,
    );
    workingTokens = afterAggressive.totalTokens;

    // ── History MMD injection after aggressive deletion ──
    if (stateManager && result.allDeletedToolCallIds.length > 0) {
      try {
        const mmdResult = await buildHistoryMmdInjection(
          result.allDeletedToolCallIds,
          offloadMap,
          offloadEntries,
          stateManager,
          effectiveLogger,
          countTokens,
          contextWindow,
          toPluginConfig(config),
        );
        if (mmdResult.injectedMessages.length > 0) {
          removeExistingMmdInjections(messages as any[]);
          const histInsertIdx = findHistoryMmdInsertionPoint(messages as any[]);
          (messages as any[]).splice(histInsertIdx, 0, ...mmdResult.injectedMessages);
          effectiveLogger.info(
            `[offload] AGGRESSIVE: injected ${mmdResult.injectedMessages.length} history MMD msg(s) at [${histInsertIdx}], ` +
            `tokens=${mmdResult.totalMmdTokens}, files=[${mmdResult.mmdFiles.join(",")}]`,
          );
          // Re-estimate working tokens after MMD injection (MMD adds tokens)
          const afterMmd = buildTiktokenContextSnapshot(
            "l3_after_aggressive_mmd",
            messages,
            null,
            null,
          );
          workingTokens = afterMmd.totalTokens;
        }
      } catch (mmdErr) {
        effectiveLogger.warn(`[offload] AGGRESSIVE: history MMD injection failed: ${mmdErr}`);
      }
    }
  }

  // 6. Mild: replace tool results with L1 summaries
  if (workingTokens >= mildThreshold && offloadMap.size > 0) {
    const tierStartedAt = Date.now();
    mildApplied = true;
    const mildScanRatio =
      config.mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;

    const cascadeResult = compressByScoreCascade(
      messages as any[],
      offloadMap,
      new Set<string>(),
      mildScanRatio,
      effectiveLogger,
    );
    mildReplacedCount = cascadeResult.replacedCount;
    effectiveLogger.info(
      `[offload] MILD: replaced ${cascadeResult.replacedCount} tool results, ` +
      `threshold=${cascadeResult.finalThreshold} [${Date.now() - tierStartedAt}ms]`,
    );
  }

  // 7. Restore messages to original format (if normalized)
  denormalizeMessages(messages, restore);

  // 8. Final token estimate
  const finalSnap = buildTiktokenContextSnapshot("l3_final", messages, null, null);
  const tokensAfter = finalSnap.totalTokens;

  return finalizeResult(messages, tokensBefore, tokensAfter, contextWindow, {
    mildApplied,
    mildReplacedCount,
    aggressiveApplied,
    aggressiveDeletedCount,
    emergencyApplied,
    emergencyDeletedCount,
  });
}

/**
 * Build a CompressionResult from the tracked state.
 */
function finalizeResult(
  messages: unknown[],
  tokensBefore: number,
  tokensAfter: number,
  contextWindow: number,
  flags: {
    mildApplied: boolean;
    mildReplacedCount: number;
    aggressiveApplied: boolean;
    aggressiveDeletedCount: number;
    emergencyApplied: boolean;
    emergencyDeletedCount: number;
  },
): CompressionResult {
  return {
    messages,
    tokensAfter,
    tokensBefore,
    mildApplied: flags.mildApplied,
    mildReplacedCount: flags.mildReplacedCount,
    aggressiveApplied: flags.aggressiveApplied,
    aggressiveDeletedCount: flags.aggressiveDeletedCount,
    emergencyApplied: flags.emergencyApplied,
    emergencyDeletedCount: flags.emergencyDeletedCount,
    utilisation: contextWindow > 0 ? tokensAfter / contextWindow : 0,
  };
}

// ─── Config conversion (OffloadConfig → Partial<PluginConfig>) ──────────

/**
 * Convert the bot's OffloadConfig to the submodule's PluginConfig shape.
 * Used when calling submodule functions that expect PluginConfig.
 */
function toPluginConfig(config: OffloadConfig): Partial<PluginConfig> {
  return {
    model: config.model,
    temperature: config.temperature,
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

// ─── Re-exported utilities ───────────────────────────────────────────────

/**
 * Detect whether an error is a token overflow / context-length error.
 * Re-exported from the submodule for use by OffloadService.
 */
export { isTokenOverflowError };

/**
 * Filter heartbeat tool call messages from the conversation array.
 * Re-exported from the submodule for use by OffloadService.
 */
export { filterHeartbeatMessages };

// ─── Legacy message normalization (simpler, no restore needed) ──────────

/**
 * Simple normalization that only adds toolCallId alias to tool result messages.
 * Does NOT convert assistant messages with tool_calls — useful when only
 * aggressive/emergency compression is needed (no mild).
 */
export function normalizeToolResultMessages(messages: unknown[]): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "tool" && !m.toolCallId && m.tool_call_id) {
      (m as Record<string, unknown>).toolCallId = m.tool_call_id;
    }
  }
}
