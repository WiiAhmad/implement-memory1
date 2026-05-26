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
import { mkdir, writeFile } from "node:fs/promises";
import OpenAI from "openai";
import { readOffloadEntries, toOffloadSessionKey, appendOffloadEntries, listMmds, readMmd, writeMmd, patchMmd, readAllOffloadEntries, rewriteAllOffloadEntries, writeRefMd, sanitizeText } from "./storage.ts";
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

export interface CreateSkillCommand {
  mmdName: string | null;
  skillFocus: string | null;
}

export class OffloadService {
  private readonly enabled: boolean;
  private readonly config: OffloadConfig;
  private readonly logger: Logger;
  private readonly getDataDir: () => string;
  private readonly l4ClientConfig: {
    baseUrl: string;
    apiKey: string;
    model: string | undefined;
    temperature: number;
  };

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
  private retentionDays = 0;

  constructor(opts: OffloadServiceOptions) {
    this.enabled = opts.enabled;
    this.config = opts.config;
    this.logger = opts.logger;
    this.getDataDir = opts.getDataDir;
    this.l4ClientConfig = {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.config.model,
      temperature: opts.config.temperature,
    };

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
   * Handle `/create-skill [mmd-name] [focus...]`.
   *
   * L4 was originally wired only in the OpenClaw plugin before-agent-start hook.
   * The Telegram bot has its own lifecycle, so it needs an explicit command
   * entry point that reads local MMD/offload state and calls the local LLM.
   */
  async createSkillFromCommand(userKey: string, userText: string): Promise<string | null> {
    const command = parseCreateSkillCommand(userText);
    if (!command) return null;

    if (!this.enabled) {
      return "L4 skill generation is unavailable because offload is disabled.";
    }

    const manager = await this.getOrCreateManager(userKey);
    if (!manager) {
      return "L4 skill generation failed: no offload session is available.";
    }

    if (!this.l4ClientConfig.baseUrl || !this.l4ClientConfig.apiKey || !this.l4ClientConfig.model) {
      return "L4 skill generation requires an offload model. Set `OFFLOAD_MODEL` or `MODEL` and restart the bot.";
    }

    try {
      const allMmds = await listMmds(manager.ctx);
      const mmdFilename = selectMmdFilename(allMmds, manager.getActiveMmdFile(), command.mmdName);
      if (!mmdFilename) {
        return command.mmdName
          ? `No MMD file matched "${command.mmdName}". Available MMDs: ${allMmds.length ? allMmds.join(", ") : "(none)"}`
          : `No active or generated MMD file is available yet. L4 needs L2 to generate an MMD first.`;
      }

      const mmdContent = await readMmd(manager.ctx, mmdFilename);
      if (!mmdContent?.trim()) {
        return `MMD file "${mmdFilename}" is empty or unreadable.`;
      }

      const allEntries = await readAllOffloadEntries(manager.ctx, this.logger);
      const nodeIds = extractNodeIds(mmdContent);
      const filteredEntries = nodeIds.size > 0
        ? allEntries.filter((entry) => typeof entry.node_id === "string" && nodeIds.has(entry.node_id))
        : allEntries;

      this.logger.info(
        `[offload] L4: generating skill from ${mmdFilename}, entries=${filteredEntries.length}, focus=${command.skillFocus ?? "null"}`,
      );

      const resp = await this.generateL4Skill({
        mmdFilename,
        mmdContent,
        offloadEntries: filteredEntries,
        skillFocus: command.skillFocus,
      });

      const skillName = sanitizeSkillName(resp.skillName);
      const skillsDir = join(manager.ctx.dataDir, "skills", skillName);
      const skillPath = join(skillsDir, "SKILL.md");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(skillPath, resp.skillContent, "utf-8");

      this.logger.info(`[offload] L4: wrote skill ${skillName} to ${skillPath}`);

      return [
        "Skill generation complete.",
        "",
        `Skill name: ${skillName}`,
        `Description: ${resp.skillDescription}`,
        `File path: ${skillPath}`,
      ].join("\n");
    } catch (err) {
      this.logger.error(`[offload] L4 failed: ${err}`);
      return `L4 skill generation failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async generateL4Skill(req: {
    mmdFilename: string;
    mmdContent: string;
    offloadEntries: OffloadEntry[];
    skillFocus: string | null;
  }): Promise<{ skillName: string; skillDescription: string; skillContent: string }> {
    const client = new OpenAI({
      baseURL: this.l4ClientConfig.baseUrl,
      apiKey: this.l4ClientConfig.apiKey,
    });

    const startedAt = Date.now();
    const userPrompt = buildL4UserPrompt(req);
    this.logger.info(
      `[offload] L4 >>> model=${this.l4ClientConfig.model}, mmd=${req.mmdFilename}, entries=${req.offloadEntries.length}, prompt=${userPrompt.length} chars`,
    );

    const response = await client.chat.completions.create(
      {
        model: this.l4ClientConfig.model!,
        temperature: this.l4ClientConfig.temperature,
        messages: [
          { role: "system", content: L4_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      },
      { signal: AbortSignal.timeout(120_000) },
    );

    const raw = response.choices?.[0]?.message?.content ?? "";
    const parsed = parseL4Response(raw);
    if (!parsed) {
      throw new Error(`L4 response parsing failed (${raw.length} chars)`);
    }

    this.logger.info(
      `[offload] L4 <<< skill=${parsed.skillName}, content=${parsed.skillContent.length} chars (${Date.now() - startedAt}ms)`,
    );
    return parsed;
  }

  /**
   * Called before the LLM reply. Compresses conversation history
   * if above configured thresholds using library L3 algorithms.
   *
   * Honors the `_forceEmergencyNext` flag set by reportTokenOverflow():
   * if a previous turn hit a context-length error, emergency compression
   * is forced regardless of current token utilisation.
   *
   * Flow:
   *   1. Resolve an OffloadStateManager for the user (creates on first access)
   *   2. Check and clear the force-emergency flag
   *   3. Read L1 offload entries from JSONL storage via the manager's ctx
   *   4. Run L3 compression orchestrator (mild/aggressive/emergency tiers)
   *   5. Log compression stats
   *   6. Inject active MMD into messages
   *   7. Return the (possibly modified) messages array
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
      this.logger.debug?.(`[offload] beforeTurn: no manager for ${userKey}, skipping`);
      return previousMessages;
    }

    this.logger.debug?.(`[offload] beforeTurn: userKey=${userKey}, msgs=${previousMessages.length}`);

    // ── Check for pending force-emergency flag (set by reportTokenOverflow) ──
    const forceEmergency = manager._forceEmergencyNext === true;
    if (forceEmergency) {
      manager._forceEmergencyNext = false;
      this.logger.warn(
        `[offload] beforeTurn: force-emergency flag set — will force emergency compression`,
      );
    }

    try {
      // 2. Read L1 offload entries from JSONL via the manager's StorageContext
      const offloadEntries: OffloadEntry[] = await readOffloadEntries(manager.ctx);

      // 3. Run L3 compression orchestrator with force-emergency flag
      const result: CompressionResult = await compressSession(
        previousMessages,
        offloadEntries,
        {
          ...this.config,
          // When force-emergency is set, lower the emergency threshold to 0
          // so compressor.ts triggers emergency compression immediately.
          emergencyCompressRatio: forceEmergency ? 0 : this.config.emergencyCompressRatio,
        },
        manager,
        this.logger,
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
          `emergency=${result.emergencyApplied ? `${result.emergencyDeletedCount} deleted` : "no"}` +
          (forceEmergency ? " (forced)" : ""),
        );
      } else if (result.tokensBefore > 0) {
        this.logger.debug?.(
          `[offload] beforeTurn: no compression needed (${result.tokensBefore} tokens)`,
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
      return previousMessages;
    }
  }

  /**
   * Called during the tool loop to buffer a tool call + result pair.
   *
   * Buffers the pair and triggers an inline L1 flush when the pending
   * count reaches forceTriggerThreshold. This keeps the pending buffer
   * small during long tool-using responses.
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

    const pending = manager.getPendingCount();

    // Estimate token impact of this tool result (rough: ~4 chars per token)
    const resultStr = stringify(pair.result);
    const resultTokens = Math.ceil(resultStr.length / 4);

    this.logger.debug?.(
      `[offload] onToolCall: userKey=${params.userKey}, tool=${params.toolName}, ` +
      `callId=${params.toolCallId}, pending=${pending}, ` +
      `resultEstTokens=${resultTokens}`,
    );

    // ── Inline L1 flush: summarise buffered pairs early when threshold reached ──
    const inlineThreshold = this.config.forceTriggerThreshold;
    if (this.config.l1Enabled && this.llmClient && pending >= inlineThreshold) {
      this.logger.info(
        `[offload] onToolCall: inline L1 flush triggered (pending=${pending} >= ${inlineThreshold})`,
      );
      await this.flushL1(manager);
    }
  }

  /**
   * Called after each step of the manual tool loop in chat-client.ts.
   * Receives the current conversation messages array and runs inline
   * L3 compression + MMD injection to prevent context bloat during
   * long tool-using turns.
   *
   * The messages are modified in-place by compressSession() and
   * injectMmdIntoMessages(), so the modified array flows back to the
   * next LLM call automatically.
   *
   * Flow:
   *   1. Convert messages to OpenAI format (compressor-friendly)
   *   2. Read offload entries for mild compression
   *   3. Run L3 compression (mild/aggressive/emergency)
   *   4. Inject active MMD into messages
   *   5. Log compression stats
   */
  async onStepFinish(messages: unknown[], userKey: string): Promise<void> {
    const startedAt = Date.now();
    if (!this.enabled) return;
    if (!messages || messages.length < 2) return;

    const manager = await this.getOrCreateManager(userKey);
    if (!manager) {
      this.logger.debug?.(`[offload] onStepFinish: no manager for ${userKey}, skipping`);
      return;
    }

    try {
      // 1. Normalise to OpenAI format for compressor compatibility
      const formatStartedAt = Date.now();
      ensureOpenAIFormat(messages);
      const formatDuration = Date.now() - formatStartedAt;

      // 2. Read offload entries from JSONL
      const readEntriesStartedAt = Date.now();
      const offloadEntries: OffloadEntry[] = await readOffloadEntries(manager.ctx);
      const readEntriesDuration = Date.now() - readEntriesStartedAt;

      // 3. Run L3 compression
      const compressStartedAt = Date.now();
      const result: CompressionResult = await compressSession(
        messages,
        offloadEntries,
        this.config,
        manager,
        this.logger,
      );
      const compressDuration = Date.now() - compressStartedAt;

      // 4. Log compression stats + timing
      if (result.tokensBefore > 0 && result.tokensBefore !== result.tokensAfter) {
        const savedPct = (
          (result.tokensBefore - result.tokensAfter) / result.tokensBefore * 100
        ).toFixed(1);
        this.logger.info(
          `[offload] onStepFinish: ${result.tokensBefore}→${result.tokensAfter} tokens ` +
          `(saved ${savedPct}%), ` +
          `mild=${result.mildApplied ? `${result.mildReplacedCount} replaced` : "no"}, ` +
          `aggressive=${result.aggressiveApplied ? `${result.aggressiveDeletedCount} deleted` : "no"}, ` +
          `emergency=${result.emergencyApplied ? `${result.emergencyDeletedCount} deleted` : "no"}` +
          ` [compress=${compressDuration}ms]`,
        );
      } else if (result.tokensBefore > 0) {
        this.logger.debug?.(
          `[offload] onStepFinish: no compression needed (${result.tokensBefore} tokens) [compress=${compressDuration}ms]`,
        );
      }

      // 5. Inject active MMD into messages (if available)
      if (this.config.l2Enabled && this.llmClient) {
        try {
          const mmdStartedAt = Date.now();
          const mmdResult = await injectMmdIntoMessages(
            messages,
            manager,
            this.logger,
            () => this.config.contextWindow,
            this._toPluginConfig(),
          );
          const mmdDuration = Date.now() - mmdStartedAt;
          if (mmdResult.mmdTokens > 0) {
            this.logger.info(
              `[offload] onStepFinish: injected active MMD (${mmdResult.mmdTokens} tokens) [mmd=${mmdDuration}ms]`,
            );
          }
        } catch (mmdErr) {
          this.logger.warn(`[offload] onStepFinish: MMD injection failed: ${mmdErr}`);
        }
      }

      const totalDuration = Date.now() - startedAt;
      this.logger.info(
        `[timing] offload.onStepFinish: total=${totalDuration}ms, ` +
        `format=${formatDuration}ms, readEntries=${readEntriesDuration}ms, ` +
        `compress=${compressDuration}ms (user=${userKey})`,
      );
    } catch (err) {
      const totalDuration = Date.now() - startedAt;
      // Catch-all: log and continue — don't crash the tool loop
      this.logger.warn(`[offload] onStepFinish: inline compression failed after ${totalDuration}ms: ${err}`);
    }
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
    const boundaryStartIndex = manager.entryCounter;

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
      l15Msgs.trim().length >= L15_MIN_CHARS_FOR_JUDGE
    ) {
      await this.judgeL15(manager, l15Msgs, boundaryStartIndex);
    } else if (this.config.l15Enabled) {
      // Short message: skip LLM call, just settle as short boundary
      if (!manager.l15Settled) {
        this.logger.debug?.(
          `[offload] L1.5: skipping judge for short msg (${l15Msgs.length} chars < ${L15_MIN_CHARS_FOR_JUDGE})`,
        );
        manager.pushBoundary({ startIndex: boundaryStartIndex, result: "short", targetMmd: null });
        manager.l15Settled = true;
      }
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

    const refByToolCallId = new Map<string, string>();
    for (const p of pairs) {
      try {
        const resultStr = typeof p.result === "string"
          ? sanitizeText(p.result)
          : sanitizeText(JSON.stringify(p.result, null, 2));
        const content = `**Tool:** ${p.toolName}\n**Call ID:** ${p.toolCallId}\n\n**Result:**\n\`\`\`\n${resultStr}\n\`\`\``;
        const refPath = await writeRefMd(manager.ctx, p.timestamp, p.toolName, content);
        refByToolCallId.set(p.toolCallId, refPath);
      } catch (err) {
        this.logger.warn(`[offload] flushL1: ref write failed for ${p.toolCallId}: ${err}`);
      }
    }

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
        result_ref: refByToolCallId.get(p.toolCallId) ?? "",
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
      result_ref: e.result_ref || refByToolCallId.get(e.tool_call_id) || "",
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
  private async judgeL15(
    manager: OffloadStateManager,
    recentMessages: string,
    startIndex: number,
  ): Promise<void> {
    this.logger.info(
      `[offload] L1.5: judging task boundary (startIndex=${startIndex}, ` +
      `activeMmd=${manager.getActiveMmdFile() ?? "null"})`,
    );

    if (await this.attemptL15(manager, recentMessages, startIndex)) return;

    // Retry up to 3 times after brief delay
    const L15_MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= L15_MAX_RETRIES; attempt++) {
      this.logger.info(`[offload] L1.5: retrying (${attempt}/${L15_MAX_RETRIES})...`);
      await this.sleep(L15_RETRY_DELAY_MS);
      if (manager.l15Settled) return; // Already settled by another path

      if (await this.attemptL15(manager, recentMessages, startIndex)) return;
    }

    // All attempts failed — activate fail-safe
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
   * Report a token overflow / context-length error to the offload service.
   * Sets the _forceEmergencyNext flag on the session's state manager so that
   * the next beforeTurn() call forces emergency compression regardless of
   * current token utilisation.
   *
   * Called by ChatService when the LLM API returns a context-length error.
   */
  async reportTokenOverflow(userKey: string): Promise<void> {
    if (!this.enabled) return;

    const manager = await this.getOrCreateManager(userKey);
    if (!manager) {
      this.logger.warn(`[offload] reportTokenOverflow: no manager for ${userKey}`);
      return;
    }

    manager._forceEmergencyNext = true;
    this.logger.warn(
      `[offload] reportTokenOverflow: set _forceEmergencyNext for ${userKey}` +
      ` (activeMmd=${manager.getActiveMmdFile() ?? "none"})`,
    );

    // Persist state so the flag survives process restarts — but note that
    // _forceEmergencyNext is a runtime-only field on OffloadStateManager
    // and is NOT persisted via save(). This is by design: the submodule
    // treats it as ephemeral state that's checked once on the next L3 entry.
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
          logMaxSizeMb: this.config.logMaxSizeMb,
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
      const batchSize = this.config.maxPairsPerBatch;
      for (let i = 0; i < mmdEntries.length; i += batchSize) {
        batches.push(mmdEntries.slice(i, i + batchSize));
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
      forceTriggerThreshold: this.config.forceTriggerThreshold,
      maxPairsPerBatch: this.config.maxPairsPerBatch,
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

/** Min user message chars before triggering L1.5 judge (avoids LLM call for "hi", "ok", etc). */
const L15_MIN_CHARS_FOR_JUDGE = 20;

/** Delay before L1.5 retry (ms). */
const L15_RETRY_DELAY_MS = 3000;

/** Data retention reclaim interval in ms (24 hours). */
const RECLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────

const L4_SYSTEM_PROMPT = `You generate Codex skill documents from completed task context.

Return only valid JSON with this exact shape:
{
  "skillName": "kebab-case-directory-name",
  "skillDescription": "one sentence description",
  "skillContent": "# Skill Name\\n\\n..."
}

The skillContent must be a complete SKILL.md. Include when to use the skill, concrete workflow steps, constraints, edge cases, and verification steps. Keep it reusable and do not include private credentials or irrelevant chat history.`;

function parseCreateSkillCommand(prompt: string): CreateSkillCommand | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/create-skill(?:\s+(.*))?$/i);
  if (!match) return null;

  const args = (match[1] || "").trim();
  if (!args) return { mmdName: null, skillFocus: null };

  const parts = args.split(/\s+/);
  return {
    mmdName: parts[0] || null,
    skillFocus: parts.slice(1).join(" ") || null,
  };
}

function selectMmdFilename(
  allMmds: string[],
  activeMmd: string | null,
  requestedName: string | null,
): string | null {
  if (requestedName) {
    const needle = requestedName.toLowerCase();
    return allMmds.find((f) => f.toLowerCase() === needle)
      ?? allMmds.find((f) => f.toLowerCase().includes(needle))
      ?? null;
  }

  if (activeMmd && allMmds.includes(activeMmd)) return activeMmd;
  return allMmds.length > 0 ? allMmds[allMmds.length - 1]! : null;
}

function extractNodeIds(mmdContent: string): Set<string> {
  const ids = new Set<string>();
  const nodeIdPattern = /\b(\d{3}-N\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = nodeIdPattern.exec(mmdContent)) !== null) {
    ids.add(match[1]!);
  }
  return ids;
}

function buildL4UserPrompt(req: {
  mmdFilename: string;
  mmdContent: string;
  offloadEntries: OffloadEntry[];
  skillFocus: string | null;
}): string {
  const entries = req.offloadEntries.map((e, idx) => ({
    index: idx + 1,
    tool_call_id: e.tool_call_id,
    node_id: e.node_id,
    tool_call: e.tool_call,
    summary: e.summary,
    timestamp: e.timestamp,
  }));

  return JSON.stringify({
    mmdFilename: req.mmdFilename,
    skillFocus: req.skillFocus,
    mmdContent: req.mmdContent,
    offloadEntries: entries,
  }, null, 2);
}

function parseL4Response(
  raw: string,
): { skillName: string; skillDescription: string; skillContent: string } | null {
  const jsonText = extractJson(raw);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (
      typeof parsed.skillName !== "string" ||
      typeof parsed.skillDescription !== "string" ||
      typeof parsed.skillContent !== "string"
    ) {
      return null;
    }

    return {
      skillName: parsed.skillName,
      skillDescription: parsed.skillDescription,
      skillContent: parsed.skillContent,
    };
  } catch {
    return null;
  }
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function sanitizeSkillName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || `generated-skill-${Date.now()}`;
}

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

/**
 * Convert messages from AI SDK CoreMessage format (content arrays with
 * tool-call blocks) to OpenAI format (content string + tool_calls array).
 *
 * This is necessary because the L3 compressor (compressor.ts) expects the
 * OpenAI format for its normalizeMessages() step.
 *
 * Modifies messages in-place. Idempotent — messages already in OpenAI
 * format are unchanged.
 *
 * Example conversion:
 *   Input:  { role: "assistant", content: [{ type: "tool-call", toolCallId: "...", toolName: "x", args: {} }] }
 *   Output: { role: "assistant", content: "", tool_calls: [{ id: "...", type: "function", function: { name: "x", arguments: "{}" } }] }
 */
function ensureOpenAIFormat(messages: unknown[]): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") continue; // Already OpenAI format

    const contentArr = m.content;
    if (!Array.isArray(contentArr) || contentArr.length === 0) continue;

    // Convert content array to OpenAI format
    const textParts: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];

    for (const block of contentArr as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool-call") {
        toolCalls.push({
          id: String(block.toolCallId ?? ""),
          type: "function",
          function: {
            name: String(block.toolName ?? ""),
            arguments:
              typeof block.args === "string"
                ? block.args
                : JSON.stringify(block.args ?? {}),
          },
        });
      }
    }

    m.content = textParts.join("");
    if (toolCalls.length > 0) {
      m.tool_calls = toolCalls;
    }
  }
}
