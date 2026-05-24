/**
 * OffloadService — Context compression engine for the Telegram bot.
 *
 * This is the main entry point for the offload module. It wraps the
 * TencentDB-Agent-Memory library's offload algorithms (L3 compression,
 * L1 summarization, L1.5 task boundary detection, L2 MMD generation)
 * into a clean lifecycle for the bot's ChatService.
 *
 * Lifecycle (called from ChatService.replyToUser()):
 *   1. beforeTurn()  — L3 compress conversation history before LLM call
 *   2. onToolCall()  — buffer tool call/result pairs during tool loop
 *   3. afterTurn()   — flush L1 entries, save state, schedule L2
 *
 * When disabled (enabled === false), all methods are no-ops.
 */
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { OffloadConfig, OffloadEntry, ToolPair } from "./types.ts";
import { configureL3TokenTracker, compressSession } from "./compressor.ts";
import type { CompressionResult } from "./compressor.ts";
import { join } from "node:path";
import { readOffloadEntries, toOffloadSessionKey, appendOffloadEntries, listMmds, readMmd, writeMmd, patchMmd, readAllOffloadEntries, rewriteAllOffloadEntries } from "./storage.ts";
import { SessionRegistry } from "./state-manager.ts";
import type { OffloadStateManager } from "./state-manager.ts";
import { createLocalLlmClient } from "./llm-client.ts";
import type { LocalLlmClient } from "../../TencentDB-Agent-Memory/src/offload/local-llm/index.ts";
import {
  normalizeJudgment,
  handleTaskTransition,
} from "../../TencentDB-Agent-Memory/src/offload/hooks/before-agent-start.ts";
import { parseMmdMeta } from "../../TencentDB-Agent-Memory/src/offload/mmd-meta.ts";
import { checkL2Trigger, backfillNodeIds } from "../../TencentDB-Agent-Memory/src/offload/pipelines/l2-mermaid.ts";
import { injectMmdIntoMessages } from "../../TencentDB-Agent-Memory/src/offload/mmd-injector.ts";
import { reclaimOffloadData } from "../../TencentDB-Agent-Memory/src/offload/reclaimer.ts";
import type { ReclaimConfig, ReclaimStats } from "../../TencentDB-Agent-Memory/src/offload/reclaimer.ts";
import type { L15Request, L2Request } from "../../TencentDB-Agent-Memory/src/offload/backend-client.ts";
import type { PluginConfig } from "../../TencentDB-Agent-Memory/src/offload/types.ts";

export interface OffloadServiceOptions {
  enabled: boolean;
  config: OffloadConfig;
  logger: Logger;
  /** Callback to resolve the data directory path at runtime. */
  getDataDir: () => string;
  /** Base URL for LLM API calls (used for offload L1/L1.5/L2). */
  baseUrl: string;
  /** API key for LLM API calls (used for offload L1/L1.5/L2). */
  apiKey: string;
}

/**
 * Parameters for beforeTurn() — called before the LLM reply.
 */
export interface BeforeTurnParams {
  userKey: string;
  userText: string;
  previousMessages: unknown[];
}

/**
 * Parameters for onToolCall() — called for each tool execution.
 */
export interface OnToolCallParams {
  userKey: string;
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
}

/**
 * Parameters for afterTurn() — called after the LLM reply.
 */
export interface AfterTurnParams {
  userKey: string;
  /** The user's text that was sent this turn (used for L1.5 context). */
  userText: string;
}

export class OffloadService {
  private readonly enabled: boolean;
  private readonly config: OffloadConfig;
  private readonly logger: Logger;
  private readonly getDataDir: () => string;

  /** Session registry: userKey → OffloadStateManager with LRU eviction (max 20). */
  private sessionRegistry: SessionRegistry | null = null;

  /** LocalLlmClient for L1/L1.5/L2 offload LLM calls (null when not configured). */
  private llmClient: LocalLlmClient | null = null;

  /** L2 polling timer handle (null when idle). */
  private l2Timer: ReturnType<typeof setTimeout> | null = null;
  /** L2 running guard — prevents concurrent L2 pipeline runs. */
  private l2Running = false;
  /** L2 poll interval in ms (default: 5s). */
  private readonly l2PollIntervalMs = 5_000;

  /** Data retention reclaim timer (24h interval, null when disabled). */
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  /** Retention days for offload data (0 = disabled). */
  private readonly retentionDays: number;

  constructor(opts: OffloadServiceOptions) {
    this.enabled = opts.enabled;
    this.config = opts.config;
    this.logger = opts.logger;
    this.getDataDir = opts.getDataDir;

    if (this.enabled) {
      const dataDir = opts.getDataDir();
      this.sessionRegistry = new SessionRegistry(dataDir);

      // Initialize the tiktoken token tracker once at startup.
      // Required before any L3 compression runs — without this, the
      // tiktoken encoder may use wrong encoding or fail to initialize.
      configureL3TokenTracker();

      // Create the local LLM client. The model is resolved upstream:
      // if OFFLOAD_MODEL is not set, src/main.ts falls back to the main
      // MODEL (gpt-4o-mini by default), so opts.config.model is always
      // a valid model name when the service is enabled.
      this.llmClient = opts.config.model
        ? createLocalLlmClient(
            {
              baseUrl: opts.baseUrl,
              apiKey: opts.apiKey,
              model: opts.config.model,
              temperature: opts.config.temperature,
            },
            this.logger,
          )
        : null;

      this.retentionDays = opts.config.offloadRetentionDays;

      // Schedule data retention reclaim if retention >= 3 days
      if (this.retentionDays >= 3) {
        this._scheduleReclaim();
      }

      this.logger.info("[offload] OffloadService initialized (enabled)");
      this.logger.info(
        `[offload] config: l1=${this.config.l1Enabled}, l1.5=${this.config.l15Enabled}, l2=${this.config.l2Enabled}, ` +
        `contextWindow=${this.config.contextWindow}, model=${this.config.model ?? "(default)"}, ` +
        `mild=${this.config.mildOffloadRatio}, aggressive=${this.config.aggressiveCompressRatio}, ` +
        `emergency=${this.config.emergencyCompressRatio}, ` +
        `retentionDays=${this.retentionDays}`,
      );
      if (this.llmClient) {
        this.logger.info(`[offload] LLM client created: model=${opts.config.model ?? "(from env)"}`);
      } else {
        this.logger.warn("[offload] LLM client not created — L1/L1.5/L2 disabled (no model configured)");
      }
    }
  }

  /**
   * Resolve or create an OffloadStateManager for the given userKey.
   * Uses SessionRegistry (LRU, max 20 sessions) for caching.
   *
   * Converts "tg:user:{id}" → "agent:telegram-bot:{id}" for the registry.
   */
  private async getOrCreateManager(userKey: string): Promise<OffloadStateManager | null> {
    const registry = this.sessionRegistry;
    if (!registry) return null;

    const offloadKey = toOffloadSessionKey(userKey);
    try {
      const sessionCtx = await registry.resolve(offloadKey);
      return sessionCtx.manager;
    } catch (err) {
      this.logger.warn(`[offload] failed to resolve session for ${userKey}: ${err}`);
      return null;
    }
  }

  /**
   * Called before the LLM reply. Compresses conversation history
   * if above configured thresholds using library L3 algorithms.
   *
   * Flow:
   *   1. Resolve an OffloadStateManager for the user (creates on first access)
   *   2. Read L1 offload entries from JSONL storage via the manager's ctx
   *   3. Run L3 compression orchestrator (mild/aggressive/emergency tiers)
   *   4. Log compression stats
   *   5. Return the (possibly modified) messages array
   *
   * No-op case: if no offload entries exist (no tool calls yet), the offload
   * lookup map is empty, so mild compression is a no-op. Aggressive and
   * emergency compression still work because they operate on message count
   * and tokens, not on offload entries.
   *
   * Returns the (possibly modified) messages array.
   */
  async beforeTurn(params: BeforeTurnParams): Promise<unknown[]> {
    if (!this.enabled) return params.previousMessages;

    const { previousMessages, userKey } = params;

    if (!previousMessages || previousMessages.length < 2) {
      return previousMessages;
    }

    const manager = await this.getOrCreateManager(userKey);
    if (!manager) {
      this.logger.debug?.(`[offload] beforeTurn: no manager for ${userKey}, skipping compression`);
      return previousMessages;
    }

    this.logger.debug?.(`[offload] beforeTurn: userKey=${userKey}, msgs=${previousMessages.length}`);

    try {
      // 2. Read L1 offload entries from JSONL via the manager's StorageContext
      //    When empty (no tool calls yet), mild compression is a no-op.
      const offloadEntries: OffloadEntry[] = await readOffloadEntries(manager.ctx);

      // 3. Run L3 compression orchestrator with the state manager
      const result: CompressionResult = await compressSession(
        previousMessages,
        offloadEntries,
        this.config,
        manager, // Pass OffloadStateManager for aggressive/emergency state tracking
        this.logger, // Logger satisfies PluginLogger structurally
      );

      // 4. Log compression stats
      if (result.tokensBefore > 0 && result.tokensBefore !== result.tokensAfter) {
        const savedPct = ((result.tokensBefore - result.tokensAfter) / result.tokensBefore * 100).toFixed(1);
        this.logger.info(
          `[offload] beforeTurn: ${result.tokensBefore}→${result.tokensAfter} tokens ` +
          `(saved ${savedPct}%), msgs=${previousMessages.length}, ` +
          `utilisation=${(result.utilisation * 100).toFixed(1)}%, ` +
          `mild=${result.mildApplied ? `${result.mildReplacedCount} replaced` : "no"}, ` +
          `aggressive=${result.aggressiveApplied ? `${result.aggressiveDeletedCount} deleted` : "no"}, ` +
          `emergency=${result.emergencyApplied ? `${result.emergencyDeletedCount} deleted` : "no"}`,
        );
      } else if (result.tokensBefore > 0) {
        this.logger.debug?.(
          `[offload] beforeTurn: no compression needed (${result.tokensBefore} tokens, ${result.utilisation * 100}% utilisation)`,
        );
      }

      // 5. Inject active MMD into messages after compression (if available)
      let finalMessages = result.messages;
      if (this.config.l2Enabled && this.llmClient) {
        try {
          const mmdResult = await injectMmdIntoMessages(
            finalMessages,
            manager,
            this.logger,
            () => this.config.contextWindow,
            this._toPluginConfig(),
          );
          if (mmdResult.mmdTokens > 0) {
            this.logger.info(`[offload] beforeTurn: injected active MMD (${mmdResult.mmdTokens} tokens)`);
          }
        } catch (mmdErr) {
          this.logger.warn(`[offload] beforeTurn: MMD injection failed: ${mmdErr}`);
        }
      }

      return finalMessages;
    } catch (err) {
      this.logger.error(`[offload] beforeTurn compression failed: ${err}`);
      // On failure, return original messages so the conversation continues
      return previousMessages;
    }
  }

  /**
   * Called during the tool loop to buffer a tool call + result pair.
   * Buffered pairs are flushed to L1 summaries in afterTurn().
   */
  async onToolCall(params: OnToolCallParams): Promise<void> {
    if (!this.enabled) return;

    const manager = await this.getOrCreateManager(params.userKey);
    if (!manager) return;

    const pair: ToolPair = {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      params: params.params as Record<string, unknown> | string,
      result: params.result,
      timestamp: new Date().toISOString(),
    };
    manager.addToolPair(pair);

    this.logger.debug?.(
      `[offload] onToolCall: userKey=${params.userKey}, tool=${params.toolName}, ` +
      `callId=${params.toolCallId}, pending=${manager.getPendingCount()}`,
    );
  }

  /**
   * Called after the LLM reply. Saves per-session state to disk.
   * Flushes buffered tool call pairs to L1 summaries when l1Enabled.
   *
   * L1 flush flow:
   *   1. Config guard: only run when config.l1Enabled === true and pending pairs exist
   *   2. Take pending tool pairs from the session manager
   *   3. Call LocalLlmClient.l1Summarize() to generate OffloadEntry summaries
   *   4. On success: append entries to offload JSONL via appendOffloadEntries()
   *   5. On failure (after 3 retries): write degraded entries (no summary, raw text)
   *
   * Future: L1.5 task boundary detection and L2 scheduling will be added
   * in later phases.
   */
  async afterTurn(params: AfterTurnParams): Promise<void> {
    if (!this.enabled) return;

    const manager = await this.getOrCreateManager(params.userKey);
    if (!manager) return;

    // ── Flush L1 tool pairs ────────────────────────────────────────
    if (this.config.l1Enabled && manager.hasPending()) {
      await this.flushL1(manager);
    }

    // ── L1.5 Task boundary detection ─────────────────────────────────
    // After L1 flush, determine if the user's activity crosses a task
    // boundary. This updates the active MMD and pushes a boundary marker
    // so L2 knows which entries belong to which task.
    const l15Msgs = params.userText;
    if (
      this.config.l15Enabled &&
      this.llmClient &&
      l15Msgs &&
      l15Msgs.trim().length > 0
    ) {
      await this.judgeL15(manager, l15Msgs);
    }

    // Persist state.json (includes active MMD, counters, boundaries)
    await manager.save();

    // ── Schedule L2 check ────────────────────────────────────────────────
    // After L1 flush + L1.5 settle, schedule a deferred L2 trigger check.
    // L2 runs independently from the main chat loop, so we fire-and-forget.
    if (this.config.l2Enabled && this.llmClient && manager.l15Settled) {
      this._scheduleL2Check(manager, "after_turn");
    }

    this.logger.debug?.(
      `[offload] afterTurn: userKey=${params.userKey}, pending=${manager.getPendingCount()}, ` +
      `entryCounter=${manager.entryCounter}, l15Settled=${manager.l15Settled}`,
    );
  }

  /**
   * Flush buffered tool pairs to L1 summaries and write to offload JSONL.
   *
   * Takes all pending tool pairs from the manager, calls the LLM to
   * generate OffloadEntry summaries, and appends them to storage.
   * On LLM failure, retries up to 3 times, then falls back to degraded
   * entries (raw truncated text, no LLM summary).
   */
  private async flushL1(manager: OffloadStateManager): Promise<void> {
    const pendingCount = manager.getPendingCount();
    if (pendingCount === 0) return;

    this.logger.info(`[offload] flushL1: flushing ${pendingCount} pending tool pairs`);

    // Take all pending pairs
    const pairs = manager.takePending(pendingCount);
    if (pairs.length === 0) return;

    // Map to the format expected by L1Request
    const toolPairs = pairs.map((p) => ({
      toolName: p.toolName,
      toolCallId: p.toolCallId,
      params: p.params,
      result: p.result,
      timestamp: p.timestamp,
    }));

    // Try to summarise via LLM (up to 3 retries)
    const llmClient = this.llmClient;
    let offloadEntries: OffloadEntry[] | null = null;
    let lastError: unknown = null;

    if (llmClient) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const recentMessages = ""; // No recent message context in standalone mode
          const response = await llmClient.l1Summarize({
            recentMessages,
            toolPairs,
          });

          if (response.entries && response.entries.length > 0) {
            offloadEntries = response.entries;
            this.logger.info(
              `[offload] flushL1: LLM summarised ${response.entries.length}/${pairs.length} pairs (attempt ${attempt})`,
            );
            break;
          }

          // LLM returned 0 entries — try again
          lastError = new Error(`L1 returned 0 entries (attempt ${attempt})`);
          this.logger.warn(`[offload] flushL1: ${lastError}`);
        } catch (err) {
          lastError = err;
          this.logger.warn(`[offload] flushL1: LLM call failed (attempt ${attempt}/3): ${err}`);
          if (attempt < 3) {
            // Brief backoff before retry
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
    }

    // Fallback: if LLM failed or returned no entries, write degraded entries
    if (!offloadEntries || offloadEntries.length === 0) {
      this.logger.warn(
        `[offload] flushL1: LLM unavailable after 3 retries — writing ${pairs.length} degraded entries` +
        (lastError ? ` (last error: ${lastError})` : ""),
      );

      offloadEntries = pairs.map((p) => ({
        tool_call_id: p.toolCallId,
        tool_call: `${p.toolName}(${truncate(stringify(p.params), 500)})`,
        summary: truncate(stringify(p.result), 2000),
        timestamp: p.timestamp,
        node_id: null,
        result_ref: "",
        score: 0,
      }));
    }

    // Ensure each entry has required fields
    const validatedEntries: OffloadEntry[] = offloadEntries.map((e) => ({
      ...e,
      tool_call_id: e.tool_call_id ?? "",
      tool_call: e.tool_call ?? "",
      summary: e.summary ?? "",
      timestamp: e.timestamp ?? new Date().toISOString(),
      node_id: e.node_id ?? null,
      result_ref: e.result_ref ?? "",
      score: e.score ?? 0,
    }));

    // Write entries to offload JSONL
    try {
      await appendOffloadEntries(manager.ctx, validatedEntries, undefined, this.logger);
      this.logger.info(
        `[offload] flushL1: wrote ${validatedEntries.length} entries to offload JSONL`,
      );

      // Increment entry counter on the manager after successful write
      manager.entryCounter += validatedEntries.length;
    } catch (err) {
      this.logger.error(`[offload] flushL1: failed to write entries: ${err}`);
    }
  }

  /**
   * L1.5 task boundary judgment. Called from afterTurn() after L1 flush.
   *
   * Determines whether the user's current activity continues a task,
   * starts a new task, or is short/casual. Updates active MMD and
   * pushes a boundary marker on the manager.
   *
   * On failure (after 1 retry with 3s backoff):
   *   - Active MMD cleared → L2 won't trigger
   *   - Short boundary pushed → entries won't pollute future L2
   *   - l15Settled = true → L2 can proceed with caution
   */
  private async judgeL15(manager: OffloadStateManager, recentMessages: string): Promise<void> {
    const startIndex = manager.entryCounter;
    this.logger.info(
      `[offload] L1.5: judging task boundary (startIndex=${startIndex}, ` +
      `activeMmd=${manager.getActiveMmdFile() ?? "null"})`,
    );

    if (await this.attemptL15(manager, recentMessages, startIndex)) return;

    // Single retry after brief delay
    this.logger.info("[offload] L1.5: retrying (1/1)...");
    await this.sleep(L15_RETRY_DELAY_MS);
    if (manager.l15Settled) return; // Already settled by another path

    if (await this.attemptL15(manager, recentMessages, startIndex)) return;

    // Both attempts failed — activate fail-safe
    await this.l15FailSafe(manager, startIndex);
  }

  /**
   * Single attempt at L1.5 judgment. Builds request, calls LLM, applies transition.
   * Returns true on success, false on failure.
   */
  private async attemptL15(
    manager: OffloadStateManager,
    recentMessages: string,
    startIndex: number,
  ): Promise<boolean> {
    try {
      // Build L1.5 request — collect available MMDs and current MMD
      const allMmdFiles = await listMmds(manager.ctx);
      const recentMmdFiles = allMmdFiles.slice(-10); // Last 10 MMDs for context

      const mmdMetas: L15Request["availableMmdMetas"] = [];
      for (const mmdFile of recentMmdFiles) {
        try {
          const content = await readMmd(manager.ctx, mmdFile);
          if (content) {
            mmdMetas.push(parseMmdMeta(
              mmdFile,
              join(manager.ctx.mmdsDir, mmdFile),
              content,
            ));
          }
        } catch {
          // Skip unreadable MMDs
        }
      }

      const currentMmdFilename = manager.getActiveMmdFile();
      let currentMmd: L15Request["currentMmd"] = null;
      if (currentMmdFilename) {
        try {
          const content = await readMmd(manager.ctx, currentMmdFilename);
          if (content) {
            currentMmd = {
              filename: currentMmdFilename,
              content,
              path: join(manager.ctx.mmdsDir, currentMmdFilename),
            };
          }
        } catch {
          // Current MMD file missing — treat as no active MMD
        }
      }

      const llmClient = this.llmClient;
      if (!llmClient) return false;

      this.logger.info(
        `[offload] L1.5: calling l15Judge (msgs=${recentMessages.length} chars, ` +
        `currentMmd=${currentMmdFilename ?? "null"}, availableMmds=${mmdMetas.length})`,
      );

      const resp = await llmClient.l15Judge({
        recentMessages,
        currentMmd,
        availableMmdMetas: mmdMetas,
      });

      // Normalize judgment (handles null fields from LLM failure)
      const judgment = normalizeJudgment(resp as unknown as Record<string, unknown>);
      if (!judgment) {
        this.logger.warn("[offload] L1.5: all-null response (LLM unavailable)");
        return false;
      }

      // Success — log and apply task transition
      this.logger.info(
        `[offload] L1.5: completed=${judgment.taskCompleted}, ` +
        `continuation=${judgment.isContinuation}, ` +
        `longTask=${judgment.isLongTask}, ` +
        `label=${judgment.newTaskLabel ?? "none"}, ` +
        `contFile=${judgment.continuationMmdFile ?? "none"}`,
      );

      // Apply MMD lifecycle (create/reactivate/clear)
      await handleTaskTransition(manager, judgment, this.logger);

      // Push boundary based on result
      const activeMmdFile = manager.getActiveMmdFile();
      if (activeMmdFile) {
        manager.pushBoundary({ startIndex, result: "long", targetMmd: activeMmdFile });
        this.logger.info(`[offload] L1.5 boundary: long @${startIndex} → ${activeMmdFile}`);
      } else {
        manager.pushBoundary({ startIndex, result: "short", targetMmd: null });
        this.logger.info(`[offload] L1.5 boundary: short @${startIndex}`);
      }

      manager.l15Settled = true;
      this.logger.info("[offload] L1.5: settled");
      return true;
    } catch (err) {
      this.logger.warn(`[offload] L1.5 attempt failed: ${err}`);
      return false;
    }
  }

  /**
   * L1.5 fail-safe: push a short boundary and clear active MMD.
   * Ensures L1.5 settles even when the LLM is completely unavailable.
   */
  private async l15FailSafe(manager: OffloadStateManager, startIndex: number): Promise<void> {
    this.logger.warn(
      `[offload] L1.5 fail-safe: settling (boundary short @${startIndex}, activeMmd→null)`,
    );
    manager.setActiveMmd(null, null);
    manager.pushBoundary({ startIndex, result: "short", targetMmd: null });
    manager.l15Settled = true;
  }

  /** Simple sleep helper. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clean shutdown. Saves all sessions and clears any timers.
   */
  async close(): Promise<void> {
    if (!this.enabled) return;

    this.logger.info("[offload] OffloadService closing — saving all sessions");

    this._clearReclaimTimer();
    this._clearL2Timer();

    const registry = this.sessionRegistry;
    if (registry) {
      let savedCount = 0;
      for (const entry of registry.values()) {
        try {
          await entry.manager.save();
          savedCount++;
        } catch (err) {
          this.logger.warn(`[offload] error saving session ${entry.sessionKey}: ${err}`);
        }
      }
      this.logger.info(`[offload] saved ${savedCount} session(s)`);
    }
  }

  // ─── Data Retention Reclaim ────────────────────────────────────────────────

  /**
   * Schedule the data retention reclaim timer.
   * Runs every 24 hours, calling reclaimOffloadData() to clean up expired
   * offload JSONL files, orphaned refs, expired MMDs, and oversized logs.
   */
  private _scheduleReclaim(): void {
    this.reclaimTimer = setInterval(async () => {
      try {
        const dataRoot = this.getDataDir();
        const reclaimConfig: ReclaimConfig = {
          retentionDays: this.retentionDays,
          logMaxSizeMb: 50,
        };

        this.logger.info(
          `[offload] reclaim: starting (retentionDays=${this.retentionDays}, dataRoot=${dataRoot})`,
        );

        const stats: ReclaimStats = await reclaimOffloadData(dataRoot, reclaimConfig, this.logger);

        this.logger.info(
          `[offload] reclaim: ` +
          `jsonl=${stats.deletedJsonl}, ` +
          `refs=${stats.deletedRefs}, ` +
          `mmds=${stats.deletedMmds}, ` +
          `logs=${stats.truncatedLogs}, ` +
          `registry=${stats.prunedRegistryEntries}`,
        );
      } catch (err) {
        this.logger.error(`[offload] reclaim error: ${err}`);
      }
    }, RECLAIM_INTERVAL_MS);

    this.logger.info(
      `[offload] reclaim: scheduled every ${RECLAIM_INTERVAL_MS / 86_400_000}d (retentionDays=${this.retentionDays})`,
    );
  }

  /** Clear the reclaim timer and set to null. */
  private _clearReclaimTimer(): void {
    if (this.reclaimTimer !== null) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
  }

  // ─── L2 Scheduler ────────────────────────────────────────────────────────

  /**
   * Schedule a deferred L2 trigger check. If a check is already scheduled,
   * this is a no-op (prevents rapid re-scheduling).
   */
  private _scheduleL2Check(manager: OffloadStateManager, reason: string): void {
    if (this.l2Timer !== null) return; // Already scheduled
    if (this.l2Running) return; // Already running

    this.logger.debug?.(`[offload] L2 schedule: scheduling check (reason=${reason})`);
    this.l2Timer = setTimeout(() => {
      this.l2Timer = null;
      this._runL2IfNeeded(manager, reason).catch((err) => {
        this.logger.warn(`[offload] L2 check failed: ${err}`);
      });
    }, this.l2PollIntervalMs);
  }

  /** Clear any pending L2 timer. */
  private _clearL2Timer(): void {
    if (this.l2Timer !== null) {
      clearTimeout(this.l2Timer);
      this.l2Timer = null;
    }
  }

  /**
   * Check if L2 should trigger, and if so, run the full L2 pipeline.
   * Uses the library's checkL2Trigger() which evaluates both null-count
   * and timeout-based triggers.
   */
  private async _runL2IfNeeded(manager: OffloadStateManager, reason: string): Promise<void> {
    if (this.l2Running) return;
    if (!this.llmClient) return;
    if (!this.config.l2Enabled) return;

    this.l2Running = true;
    try {
      const result = await checkL2Trigger(manager, this._toPluginConfig(), this.logger);
      if (!result.shouldTrigger) {
        this.logger.debug?.(`[offload] L2 check: no trigger (${result.reason})`);
        return;
      }

      this.logger.info(
        `[offload] L2 triggered (${reason}): ${result.reason}, ` +
        `${result.entriesByMmd.size} mmd(s): [${Array.from(result.entriesByMmd.keys()).join(", ")}]`,
      );

      await this._runL2Pipeline(manager, result.entriesByMmd, reason);
    } catch (err) {
      this.logger.error(`[offload] L2 check error: ${err}`);
    } finally {
      this.l2Running = false;
      // Re-schedule if there are still null entries (retry cycle)
      try {
        const allEntries = await readAllOffloadEntries(manager.ctx);
        const nullCount = allEntries.filter((e) => e.node_id === null).length;
        if (nullCount >= this.config.l2NullThreshold) {
          this._scheduleL2Check(manager, "recheck");
        }
      } catch {
        // Ignore re-schedule errors
      }
    }
  }

  /**
   * Run the full L2 pipeline for each MMD group.
   * For each MMD file with eligible entries:
   *   1. Call llmClient.l2Generate() with the batch
   *   2. Write MMD file (via writeMmd or patchMmd)
   *   3. Backfill node IDs
   *   4. Update lastL2TriggerTime
   */
  private async _runL2Pipeline(
    manager: OffloadStateManager,
    entriesByMmd: Map<string, any[]>,
    triggerSource: string,
  ): Promise<void> {
    const llmClient = this.llmClient;
    if (!llmClient) return;

    for (const [mmdFile, mmdEntries] of entriesByMmd) {
      const taskLabel = mmdFile.replace(/^\d+-/, "").replace(/\.mmd$/, "") || "unnamed-task";
      const prefixMatch = mmdFile.match(/^(\d+)-/);
      const mmdPrefix = (prefixMatch?.[1]) ?? "000";

      // Split entries into batches to avoid oversized requests
      const batches: any[][] = [];
      for (let i = 0; i < mmdEntries.length; i += L2_BATCH_SIZE) {
        batches.push(mmdEntries.slice(i, i + L2_BATCH_SIZE));
      }
      this.logger.info(
        `[offload] L2 pipeline: mmd=${mmdFile}, ${mmdEntries.length} entries → ${batches.length} batch(es)`,
      );

      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        const batch = batches[bIdx]!;
        const batchWaitIds = new Set(batch.map((e: any) => e.tool_call_id as string));

        // Read fresh MMD for each batch (previous batch may have updated it)
        const existingMmd = await readMmd(manager.ctx, mmdFile);

        // Build L2 request
        const req: L2Request = {
          existingMmd,
          newEntries: batch.map((e: any) => ({
            tool_call_id: e.tool_call_id,
            tool_call: e.tool_call,
            summary: e.summary,
            timestamp: e.timestamp,
          })),
          recentHistory: manager.cachedRecentHistory ?? null,
          currentTurn: manager.cachedLatestTurnMessages ?? null,
          taskLabel,
          mmdPrefix,
          mmdCharCount: existingMmd ? existingMmd.length : 0,
        };

        // Mark batch entries as "wait" before calling LLM
        const allEntries = await readAllOffloadEntries(manager.ctx);
        let changed = false;
        for (const entry of allEntries) {
          if (batchWaitIds.has(entry.tool_call_id) && entry.node_id === null) {
            entry.node_id = "wait";
            changed = true;
          }
        }
        if (changed) {
          await rewriteAllOffloadEntries(manager.ctx, allEntries);
        }

        // Set trigger time on first batch
        if (bIdx === 0) {
          manager.setLastL2TriggerTime(new Date().toISOString());
          await manager.save();
        }

        try {
          this.logger.info(
            `[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length}: calling l2Generate (${batch.length} entries)`,
          );

          const resp = await llmClient.l2Generate(req);

          // Handle degraded response (empty fileAction = LLM unavailable)
          if (!resp.fileAction) {
            this.logger.warn(
              `[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length}: degraded response, fallback backfill`,
            );
            await backfillNodeIds(manager.ctx, resp.nodeMapping ?? {}, batchWaitIds, this.logger, {
              mmdFallbackText: existingMmd ?? "",
              mmdPrefix,
            });
            continue;
          }

          // Apply MMD file changes
          if (resp.fileAction === "replace" && resp.replaceBlocks && resp.replaceBlocks.length > 0) {
            const patchOk = await patchMmd(manager.ctx, mmdFile, resp.replaceBlocks);
            this.logger.info(
              `[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length}: patch ${patchOk ? "ok" : "FAILED"} (${resp.replaceBlocks.length} blocks)`,
            );
            if (!patchOk && resp.mmdContent) {
              await writeMmd(manager.ctx, mmdFile, resp.mmdContent);
              this.logger.info(`[offload] L2 ${mmdFile}: fallback writeMmd (${resp.mmdContent.length} chars)`);
            }
          } else if (resp.mmdContent) {
            await writeMmd(manager.ctx, mmdFile, resp.mmdContent);
            this.logger.info(`[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length}: writeMmd (${resp.mmdContent.length} chars)`);
          }

          // Backfill node IDs
          const mmdAfterWrite = await readMmd(manager.ctx, mmdFile);
          const mmdForBackfill =
            typeof mmdAfterWrite === "string" && mmdAfterWrite.trim().length > 0
              ? mmdAfterWrite
              : typeof existingMmd === "string" && existingMmd.trim().length > 0
                ? existingMmd
                : "";
          await backfillNodeIds(manager.ctx, resp.nodeMapping ?? {}, batchWaitIds, this.logger, {
            mmdFallbackText: mmdForBackfill,
            mmdPrefix,
          });

          this.logger.info(
            `[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length} (${triggerSource}): done, ` +
            `action=${resp.fileAction}, mapping=${Object.keys(resp.nodeMapping ?? {}).length}`,
          );
        } catch (err) {
          this.logger.error(
            `[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length} failed: ${err}`,
          );
          // Continue with remaining batches — failed entries stay as "wait" for retry
        }
      }
    }
  }

  /**
   * Convert OffloadConfig to library PluginConfig shape for downstream calls.
   */
  private _toPluginConfig(): Partial<PluginConfig> {
    return {
      model: this.config.model,
      temperature: this.config.temperature,
      l2NullThreshold: this.config.l2NullThreshold,
      l2TimeoutSeconds: this.config.l2TimeoutSeconds,
      mildOffloadRatio: this.config.mildOffloadRatio,
      aggressiveCompressRatio: this.config.aggressiveCompressRatio,
      emergencyCompressRatio: this.config.emergencyCompressRatio,
      emergencyTargetRatio: this.config.emergencyTargetRatio,
      aggressiveDeleteRatio: this.config.aggressiveDeleteRatio,
      mildOffloadScanRatio: this.config.mildOffloadScanRatio,
      mmdMaxTokenRatio: this.config.mmdMaxTokenRatio,
      defaultContextWindow: this.config.contextWindow,
    };
  }
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Delay before L1.5 retry (ms). */
const L15_RETRY_DELAY_MS = 3000;

/** Max entries per L2 batch. */
const L2_BATCH_SIZE = 30;

/** Data retention reclaim interval in ms (24 hours). */
const RECLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
