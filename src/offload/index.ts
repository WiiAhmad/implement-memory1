// ═══════════════════════════════════════════════════════════════════════
//  [Step 35]  OFFLOAD SERVICE — Context Compression Engine
//  ═══════════════════════════════════════════════════════════════════════
//  Main entry point for the offload context compression system.
//  Wraps the TDAI library's offload algorithms into a clean lifecycle
//  for the bot's ChatService.
//
//  Lifecycle (called from ContextAgent.reply()):
//    1. beforeTurn()  — L3 compress conversation history before LLM call
//    2. onToolCall()  — buffer tool call/result pairs during tool loop
//    3. onStepFinish()— inline L3 compression between tool rounds
//    4. afterTurn()   — flush L1 entries, L1.5 judgment, save state, schedule L2
//    5. createSkillFromCommand() — L4 skill generation
//
//  When disabled (enabled === false), all methods are no-ops.
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { OffloadConfig, OffloadEntry, ToolPair } from "./types.ts";
import { configureL3TokenTracker, compressSession } from "./compressor.ts";
import type { CompressionResult } from "./compressor.ts";
import { createL3TokenCounter } from "../../TencentDB-Agent-Memory/src/offload/l3-token-counter.js";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import OpenAI from "openai";
import { readOffloadEntries, toOffloadSessionKey, appendOffloadEntries, listMmds, readMmd, writeMmd, patchMmd, readAllOffloadEntries, rewriteAllOffloadEntries, writeRefMd, sanitizeText } from "./storage.ts";
import { SessionRegistry } from "./state-manager.ts";
import type { OffloadStateManager } from "./state-manager.ts";
import { createLocalLlmClient } from "./llm-client.ts";
import type { LocalLlmClient } from "../../TencentDB-Agent-Memory/src/offload/local-llm/index.ts";
import { normalizeJudgment, handleTaskTransition } from "../../TencentDB-Agent-Memory/src/offload/hooks/before-agent-start.ts";
import { parseMmdMeta } from "../../TencentDB-Agent-Memory/src/offload/mmd-meta.ts";
import { checkL2Trigger, backfillNodeIds } from "../../TencentDB-Agent-Memory/src/offload/pipelines/l2-mermaid.ts";
import { injectMmdIntoMessages } from "../../TencentDB-Agent-Memory/src/offload/mmd-injector.ts";
import { reclaimOffloadData } from "../../TencentDB-Agent-Memory/src/offload/reclaimer.ts";
import type { ReclaimStats } from "../../TencentDB-Agent-Memory/src/offload/reclaimer.ts";
import type { L15Request, L2Request } from "../../TencentDB-Agent-Memory/src/offload/backend-client.ts";
import type { PluginConfig } from "../../TencentDB-Agent-Memory/src/offload/types.ts";
import type { CoordinationService } from "../services/coordination.ts";

export interface OffloadServiceOptions {
  enabled: boolean;
  config: OffloadConfig;
  logger: Logger;
  getDataDir: () => string;
  baseUrl: string;
  apiKey: string;
  coordination?: CoordinationService;
}

export interface BeforeTurnParams {
  userKey: string;
  userText: string;
  previousMessages: unknown[];
}

export interface OnToolCallParams {
  userKey: string;
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
}

export interface AfterTurnParams {
  userKey: string;
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
    baseUrl: string; apiKey: string; model: string | undefined; temperature: number;
  };

  private sessionRegistry: SessionRegistry | null = null;
  private llmClient: LocalLlmClient | null = null;
  private l2Timer: ReturnType<typeof setTimeout> | null = null;
  private l2Running = false;
  private readonly l2PollIntervalMs = 5_000;
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private retentionDays = 0;
  private reclaimFeatureGate = false;
  private waitRetryFeatureGate = false;
  private readonly coordination?: CoordinationService;

  constructor(opts: OffloadServiceOptions) {
    // ─── Step 35a: Store configuration ──────────────────────────────────
    this.enabled = opts.enabled;
    this.config = opts.config;
    this.logger = opts.logger;
    this.getDataDir = opts.getDataDir;
    this.l4ClientConfig = {
      baseUrl: opts.baseUrl, apiKey: opts.apiKey,
      model: opts.config.model, temperature: opts.config.temperature,
    };

    this.coordination = opts.coordination;

    if (this.enabled) {
      // ─── Step 35a-i: Create session registry for LRU session caching ──
      const dataDir = opts.getDataDir();
      this.sessionRegistry = new SessionRegistry(dataDir);

      // ─── Step 35a-ii: Initialize tiktoken token tracker ──────────────
      configureL3TokenTracker();

      // ─── Step 35a-iii: Create LocalLlmClient for offload LLM calls ──
      this.llmClient = opts.config.model
        ? createLocalLlmClient(
            {
              baseUrl: opts.baseUrl,
              apiKey: opts.apiKey,
              model: opts.config.model,
              temperature: opts.config.temperature,
              timeoutMs: opts.config.backendTimeoutMs,
            },
            this.logger,
          )
        : null;

      // ─── Step 35a-iv: Schedule data retention reclaim ────────────────
      this.retentionDays = opts.config.offloadRetentionDays;
      // Reclaim is gated by both retentionDays >= 3 AND the feature gate
      this.reclaimFeatureGate = opts.config.reclaimEnabled === true;
      this.waitRetryFeatureGate = opts.config.waitRetryEnabled === true;
      if (this.retentionDays >= 3 && this.reclaimFeatureGate) this._scheduleReclaim();

      this.logger.info("[offload] OffloadService initialized (enabled)");
      this.logger.info(
        `[offload] config: l1=${this.config.l1Enabled}, l1.5=${this.config.l15Enabled}, l2=${this.config.l2Enabled}, ` +
        `contextWindow=${this.config.contextWindow}, model=${this.config.model ?? "(default)"}, ` +
        `mild=${this.config.mildOffloadRatio}, aggressive=${this.config.aggressiveCompressRatio}, ` +
        `emergency=${this.config.emergencyCompressRatio}, retentionDays=${this.retentionDays}`,
      );
    }
  }

  // ─── Step 35b: Resolve or create session manager for a user ─────────
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

  // ─── Step 35c: L4 — Handle /create-skill command ────────────────────
  async createSkillFromCommand(userKey: string, userText: string): Promise<string | null> {
    const command = parseCreateSkillCommand(userText);
    if (!command) return null;
    if (!this.enabled) return "L4 skill generation is unavailable because offload is disabled.";

    const manager = await this.getOrCreateManager(userKey);
    if (!manager) return "L4 skill generation failed: no offload session is available.";
    if (!this.l4ClientConfig.baseUrl || !this.l4ClientConfig.apiKey || !this.l4ClientConfig.model) {
      return "L4 skill generation requires an offload model. Set `OFFLOAD_MODEL` or `MODEL` and restart the bot.";
    }

    try {
      // ─── Step 35c-i: Resolve MMD file ─────────────────────────────
      const allMmds = await listMmds(manager.ctx);
      const mmdFilename = selectMmdFilename(allMmds, manager.getActiveMmdFile(), command.mmdName);
      if (!mmdFilename) return command.mmdName
        ? `No MMD file matched "${command.mmdName}". Available MMDs: ${allMmds.length ? allMmds.join(", ") : "(none)"}`
        : `No active or generated MMD file is available yet. L4 needs L2 to generate an MMD first.`;

      const mmdContent = await readMmd(manager.ctx, mmdFilename);
      if (!mmdContent?.trim()) return `MMD file "${mmdFilename}" is empty or unreadable.`;

      // ─── Step 35c-ii: Filter offload entries by MMD node IDs ─────────
      const allEntries = await readAllOffloadEntries(manager.ctx, this.logger);
      const nodeIds = extractNodeIds(mmdContent);
      const filteredEntries = nodeIds.size > 0
        ? allEntries.filter((entry) => typeof entry.node_id === "string" && nodeIds.has(entry.node_id))
        : allEntries;

      // ─── Step 35c-iii: Generate skill via LLM ────────────────────────
      const resp = await this.generateL4Skill({
        mmdFilename, mmdContent, offloadEntries: filteredEntries, skillFocus: command.skillFocus,
      });

      // ─── Step 35c-iv: Write skill file to disk ───────────────────────
      const skillName = sanitizeSkillName(resp.skillName);
      const skillsDir = join(manager.ctx.dataDir, "skills", skillName);
      const skillPath = join(skillsDir, "SKILL.md");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(skillPath, resp.skillContent, "utf-8");

      this.logger.info(`[offload] L4: wrote skill ${skillName} to ${skillPath}`);
      return `Skill generation complete.\n\nSkill name: ${skillName}\nDescription: ${resp.skillDescription}\nFile path: ${skillPath}`;
    } catch (err) {
      this.logger.error(`[offload] L4 failed: ${err}`);
      return `L4 skill generation failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ─── Step 35c-v: Call LLM for L4 skill generation ────────────────────
  private async generateL4Skill(req: {
    mmdFilename: string; mmdContent: string; offloadEntries: OffloadEntry[]; skillFocus: string | null;
  }): Promise<{ skillName: string; skillDescription: string; skillContent: string }> {
    const client = new OpenAI({ baseURL: this.l4ClientConfig.baseUrl, apiKey: this.l4ClientConfig.apiKey });
    const startedAt = Date.now();
    const userPrompt = buildL4UserPrompt(req);
    const response = await client.chat.completions.create(
      { model: this.l4ClientConfig.model!, temperature: this.l4ClientConfig.temperature,
        messages: [{ role: "system", content: L4_SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
      }, { signal: AbortSignal.timeout(120_000) },
    );
    const raw = response.choices?.[0]?.message?.content ?? "";
    const parsed = parseL4Response(raw);
    if (!parsed) throw new Error(`L4 response parsing failed (${raw.length} chars)`);
    this.logger.info(`[offload] L4 <<< skill=${parsed.skillName}, content=${parsed.skillContent.length} chars (${Date.now() - startedAt}ms)`);
    return parsed;
  }

  // ─── Step 35d: beforeTurn — L3 compression before LLM round ─────────
  //  1. Resolve session manager for the user
  //  2. Check force-emergency flag (set by reportTokenOverflow)
  //  3. Read L1 offload entries from JSONL
  //  4. Run L3 compression (mild/aggressive/emergency tiers)
  //  5. Inject active MMD into messages
  //  6. Return (possibly modified) messages
  async beforeTurn(params: BeforeTurnParams): Promise<unknown[]> {
    if (!this.enabled) return params.previousMessages;
    const { previousMessages, userKey } = params;
    if (!previousMessages || previousMessages.length < 2) return previousMessages;

    const manager = await this.getOrCreateManager(userKey);
    if (!manager) return previousMessages;

    const forceEmergency = manager._forceEmergencyNext === true;
    if (forceEmergency) {
      manager._forceEmergencyNext = false;
      this.logger.warn(`[offload] beforeTurn: force-emergency flag set`);
    }

    try {
      const offloadEntries: OffloadEntry[] = await readOffloadEntries(manager.ctx);
      const result: CompressionResult = await compressSession(
        previousMessages, offloadEntries,
        { ...this.config, emergencyCompressRatio: forceEmergency ? 0 : this.config.emergencyCompressRatio },
        manager, this.logger,
      );

      // Log compression stats
      if (result.tokensBefore > 0 && result.tokensBefore !== result.tokensAfter) {
        const savedPct = ((result.tokensBefore - result.tokensAfter) / result.tokensBefore * 100).toFixed(1);
        this.logger.info(
          `[offload] beforeTurn: ${result.tokensBefore}→${result.tokensAfter} tokens (saved ${savedPct}%), ` +
          `utilisation=${(result.utilisation * 100).toFixed(1)}%, ` +
          `mild=${result.mildApplied ? `${result.mildReplacedCount} replaced` : "no"}, ` +
          `aggressive=${result.aggressiveApplied ? `${result.aggressiveDeletedCount} deleted` : "no"}, ` +
          `emergency=${result.emergencyApplied ? `${result.emergencyDeletedCount} deleted` : "no"}` +
          (forceEmergency ? " (forced)" : ""),
        );
      }

      // Guard MMD size before injection
      await this.guardMmdSize(manager);

      // Inject active MMD
      let finalMessages = result.messages;
      if (this.config.l2Enabled && this.llmClient) {
        try {
          const mmdResult = await injectMmdIntoMessages(finalMessages, manager, this.logger, () => this.config.contextWindow, this._toPluginConfig());
          if (mmdResult.mmdTokens > 0) this.logger.info(`[offload] beforeTurn: injected active MMD (${mmdResult.mmdTokens} tokens)`);
        } catch (mmdErr) { this.logger.warn(`[offload] beforeTurn: MMD injection failed: ${mmdErr}`); }
      }
      return finalMessages;
    } catch (err) {
      this.logger.error(`[offload] beforeTurn compression failed: ${err}`);
      return previousMessages;
    }
  }

  // ─── Step 35e: onToolCall — Buffer tool call + result pair ──────────
  //  During the LLM tool loop, each tool call/result pair is buffered.
  //  When pending count reaches forceTriggerThreshold, triggers inline L1 flush.
  async onToolCall(params: OnToolCallParams): Promise<void> {
    if (!this.enabled) return;
    const manager = await this.getOrCreateManager(params.userKey);
    if (!manager) return;

    const pair: ToolPair = { toolName: params.toolName, toolCallId: params.toolCallId,
      params: params.params as Record<string, unknown> | string, result: params.result,
      timestamp: new Date().toISOString() };
    manager.addToolPair(pair);

    const pending = manager.getPendingCount();
    if (this.config.l1Enabled && this.llmClient && pending >= this.config.forceTriggerThreshold) {
      this.logger.info(`[offload] onToolCall: inline L1 flush triggered (pending=${pending} >= ${this.config.forceTriggerThreshold})`);
      await this.flushL1(manager);
    }
  }

  // ─── Step 35f: onStepFinish — Inline L3 compression between tool rounds
  async onStepFinish(messages: unknown[], userKey: string): Promise<void> {
    const startedAt = Date.now();
    if (!this.enabled || !messages || messages.length < 2) return;
    const manager = await this.getOrCreateManager(userKey);
    if (!manager) return;

    try {
      ensureOpenAIFormat(messages);
      const offloadEntries: OffloadEntry[] = await readOffloadEntries(manager.ctx);

      const compressStartedAt = Date.now();
      const result: CompressionResult = await compressSession(messages, offloadEntries, this.config, manager, this.logger);
      const compressDuration = Date.now() - compressStartedAt;

      if (result.tokensBefore > 0 && result.tokensBefore !== result.tokensAfter) {
        const savedPct = ((result.tokensBefore - result.tokensAfter) / result.tokensBefore * 100).toFixed(1);
        this.logger.info(
          `[offload] onStepFinish: ${result.tokensBefore}→${result.tokensAfter} tokens (saved ${savedPct}%), ` +
          `mild=${result.mildApplied ? `${result.mildReplacedCount} replaced` : "no"}, ` +
          `aggressive=${result.aggressiveApplied ? `${result.aggressiveDeletedCount} deleted` : "no"}, ` +
          `emergency=${result.emergencyApplied ? `${result.emergencyDeletedCount} deleted` : "no"} [compress=${compressDuration}ms]`,
        );
      }

      // Guard MMD size before injection
      await this.guardMmdSize(manager);

      if (this.config.l2Enabled && this.llmClient) {
        try {
          const mmdResult = await injectMmdIntoMessages(messages, manager, this.logger, () => this.config.contextWindow, this._toPluginConfig());
          if (mmdResult.mmdTokens > 0) this.logger.info(`[offload] onStepFinish: injected active MMD (${mmdResult.mmdTokens} tokens)`);
        } catch (mmdErr) { this.logger.warn(`[offload] onStepFinish: MMD injection failed: ${mmdErr}`); }
      }
    } catch (err) {
      this.logger.warn(`[offload] onStepFinish: inline compression failed after ${Date.now() - startedAt}ms: ${err}`);
    }
  }

  // ─── Step 35g: afterTurn — Flush L1, L1.5 judgment, save state, schedule L2
  async afterTurn(params: AfterTurnParams): Promise<void> {
    if (!this.enabled) return;
    const manager = await this.getOrCreateManager(params.userKey);
    if (!manager) return;

    const boundaryStartIndex = manager.entryCounter;

    // ─── Step 35g-i: Flush L1 tool pairs to summaries ───────────────
    if (this.config.l1Enabled && manager.hasPending()) {
      this.logger.info(`[offload] [l1] flush reason=after_turn session=${params.userKey} pending=${manager.getPendingCount()}`);
      await this.flushL1(manager);
    } else if (manager.hasPending()) {
      this.logger.info(`[offload] [l1] skipped reason=disabled session=${params.userKey}`);
    } else {
      this.logger.debug(`[offload] [l1] skipped reason=no_pending session=${params.userKey}`);
    }

    // ─── Step 35g-ii: L1.5 task boundary detection ──────────────────
    if (this.config.l15Enabled && this.llmClient && params.userText.trim().length >= L15_MIN_CHARS_FOR_JUDGE) {
      await this.judgeL15(manager, params.userText, boundaryStartIndex);
    } else if (this.config.l15Enabled) {
      if (!manager.l15Settled) {
        manager.pushBoundary({ startIndex: boundaryStartIndex, result: "short", targetMmd: null });
        manager.l15Settled = true;
      }
    }

    // ─── Step 35g-iii: Persist state ────────────────────────────────
    await manager.save();

    // ─── Step 35g-iv: Schedule L2 check ─────────────────────────────
    if (this.config.l2Enabled && this.llmClient && manager.l15Settled) this._scheduleL2Check(manager, "after_turn");
  }

  // ─── Step 35h: Flush buffered tool pairs to L1 summaries ────────────
  private async flushL1(manager: OffloadStateManager): Promise<void> {
    const pendingCount = manager.getPendingCount();
    if (pendingCount === 0) return;

    const pairs = manager.takePending(pendingCount);
    if (pairs.length === 0) return;

    const toolPairs = pairs.map((p) => ({ toolName: p.toolName, toolCallId: p.toolCallId,
      params: p.params, result: p.result, timestamp: p.timestamp }));

    // Write ref files for each pair
    const refByToolCallId = new Map<string, string>();
    for (const p of pairs) {
      try {
        const resultStr = typeof p.result === "string" ? sanitizeText(p.result) : sanitizeText(JSON.stringify(p.result, null, 2));
        const content = `**Tool:** ${p.toolName}\n**Call ID:** ${p.toolCallId}\n\n**Result:**\n\`\`\`\n${resultStr}\n\`\`\``;
        const refPath = await writeRefMd(manager.ctx, p.timestamp, p.toolName, content);
        refByToolCallId.set(p.toolCallId, refPath);
      } catch (err) { this.logger.warn(`[offload] flushL1: ref write failed for ${p.toolCallId}: ${err}`); }
    }

    // Try LLM summarization (up to 3 retries), fallback to degraded entries
    let offloadEntries: OffloadEntry[] | null = null;
    let lastError: unknown = null;
    if (this.llmClient) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await this.llmClient.l1Summarize({ recentMessages: "", toolPairs });
          if (response.entries && response.entries.length > 0) {
            offloadEntries = response.entries;
            break;
          }
          lastError = new Error(`L1 returned 0 entries (attempt ${attempt})`);
        } catch (err) {
          lastError = err;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    // Fallback: write degraded entries (no LLM summary)
    if (!offloadEntries || offloadEntries.length === 0) {
      offloadEntries = pairs.map((p) => ({
        tool_call_id: p.toolCallId, tool_call: `${p.toolName}(${truncate(stringify(p.params), 500)})`,
        summary: truncate(stringify(p.result), 2000), timestamp: p.timestamp,
        node_id: null, result_ref: refByToolCallId.get(p.toolCallId) ?? "", score: 0,
      }));
    }

    const validatedEntries = offloadEntries.map((e) => ({
      ...e, tool_call_id: e.tool_call_id ?? "", tool_call: e.tool_call ?? "",
      summary: e.summary ?? "", timestamp: e.timestamp ?? new Date().toISOString(),
      node_id: e.node_id ?? null, result_ref: e.result_ref || refByToolCallId.get(e.tool_call_id) || "", score: e.score ?? 0,
    }));

    // Write to JSONL
    try {
      await appendOffloadEntries(manager.ctx, validatedEntries, undefined, this.logger);
      manager.entryCounter += validatedEntries.length;
      this.logger.info(`[offload] [l1] wrote ${validatedEntries.length} entries to offload JSONL session=${manager.ctx.sessionKey} fallback=${!offloadEntries || offloadEntries.length === 0}`);
    } catch (err) { this.logger.error(`[offload] flushL1: failed to write entries: ${err}`); }
  }

  // ─── Step 35i: L1.5 — Judge task boundary ────────────────────────────
  private async judgeL15(manager: OffloadStateManager, recentMessages: string, startIndex: number): Promise<void> {
    if (await this.attemptL15(manager, recentMessages, startIndex)) {
      this.logger.info(`[offload] [l1.5] judge result=continue|short|long session=${manager.ctx.sessionKey}`);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.sleep(3000);
      if (manager.l15Settled) {
        this.logger.info(`[offload] [l1.5] already_settled attempt=${attempt} session=${manager.ctx.sessionKey}`);
        return;
      }
      if (await this.attemptL15(manager, recentMessages, startIndex)) {
        this.logger.info(`[offload] [l1.5] judge result=continue|short|long retry=${attempt} session=${manager.ctx.sessionKey}`);
        return;
      }
      this.logger.warn(`[offload] [l1.5] attempt_failed retry=${attempt} session=${manager.ctx.sessionKey}`);
    }
    this.logger.warn(`[offload] [l1.5] failsafe_triggered session=${manager.ctx.sessionKey}`);
    await this.l15FailSafe(manager, startIndex);
  }

  private async attemptL15(manager: OffloadStateManager, recentMessages: string, startIndex: number): Promise<boolean> {
    try {
      // Enrich recent messages with active scene context for MMD naming (Phase 5)
      const enrichedMessages = this.coordination
        ? await this.coordination.enrichL15Context(manager.ctx.sessionKey, recentMessages)
        : recentMessages;

      const allMmdFiles = await listMmds(manager.ctx);
      const mmdMetas: L15Request["availableMmdMetas"] = [];
      for (const mmdFile of allMmdFiles.slice(-10)) {
        try { const content = await readMmd(manager.ctx, mmdFile); if (content) mmdMetas.push(parseMmdMeta(mmdFile, join(manager.ctx.mmdsDir, mmdFile), content)); } catch { /* skip */ }
      }

      const currentMmdFilename = manager.getActiveMmdFile();
      let currentMmd: L15Request["currentMmd"] = null;
      if (currentMmdFilename) {
        try { const content = await readMmd(manager.ctx, currentMmdFilename); if (content) currentMmd = { filename: currentMmdFilename, content, path: join(manager.ctx.mmdsDir, currentMmdFilename) }; } catch { /* ignore */ }
      }

      const llmClient = this.llmClient;
      if (!llmClient) return false;

      const resp = await llmClient.l15Judge({ recentMessages: enrichedMessages, currentMmd, availableMmdMetas: mmdMetas });
      const judgment = normalizeJudgment(resp as unknown as Record<string, unknown>);
      if (!judgment) return false;

      await handleTaskTransition(manager, judgment, this.logger);
      const activeMmdFile = manager.getActiveMmdFile();
      if (activeMmdFile) { manager.pushBoundary({ startIndex, result: "long", targetMmd: activeMmdFile }); }
      else { manager.pushBoundary({ startIndex, result: "short", targetMmd: null }); }
      manager.l15Settled = true;
      return true;
    } catch (err) { return false; }
  }

  private async l15FailSafe(manager: OffloadStateManager, startIndex: number): Promise<void> {
    manager.setActiveMmd(null, null);
    manager.pushBoundary({ startIndex, result: "short", targetMmd: null });
    manager.l15Settled = true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Step 35j: Report token overflow ─────────────────────────────────
  async reportTokenOverflow(userKey: string): Promise<void> {
    if (!this.enabled) return;
    const manager = await this.getOrCreateManager(userKey);
    if (!manager) return;
    manager._forceEmergencyNext = true;
    this.logger.warn(`[offload] reportTokenOverflow: set _forceEmergencyNext for ${userKey}`);
  }

  // ─── Step 35k: Clean shutdown — save all sessions, clear timers ──────
  async close(): Promise<void> {
    if (!this.enabled) return;
    this.logger.info("[offload] OffloadService closing — saving all sessions");
    this._clearReclaimTimer();
    this._clearL2Timer();
    const registry = this.sessionRegistry;
    if (registry) {
      let savedCount = 0;
      for (const entry of registry.values()) {
        try { await entry.manager.save(); savedCount++; } catch (err) { this.logger.warn(`[offload] error saving session ${entry.sessionKey}: ${err}`); }
      }
      this.logger.info(`[offload] saved ${savedCount} session(s)`);
    }
  }

  // ─── Step 35l: Data retention reclaim (24h interval) ────────────────
  private _scheduleReclaim(): void {
    this.reclaimTimer = setInterval(async () => {
      try {
        const stats: ReclaimStats = await reclaimOffloadData(this.getDataDir(), { retentionDays: this.retentionDays, logMaxSizeMb: this.config.logMaxSizeMb }, this.logger);
        this.logger.info(`[offload] reclaim: jsonl=${stats.deletedJsonl}, refs=${stats.deletedRefs}, mmds=${stats.deletedMmds}, logs=${stats.truncatedLogs}, registry=${stats.prunedRegistryEntries}`);
      } catch (err) { this.logger.error(`[offload] reclaim error: ${err}`); }
    }, 24 * 60 * 60 * 1000);
  }

  private _clearReclaimTimer(): void {
    if (this.reclaimTimer !== null) { clearInterval(this.reclaimTimer); this.reclaimTimer = null; }
  }

  // ─── Step 35m: L2 scheduler ──────────────────────────────────────────
  private _scheduleL2Check(manager: OffloadStateManager, reason: string): void {
    if (this.l2Timer !== null || this.l2Running) return;
    this.l2Timer = setTimeout(() => {
      this.l2Timer = null;
      this._runL2IfNeeded(manager, reason).catch((err) => this.logger.warn(`[offload] L2 check failed: ${err}`));
    }, this.l2PollIntervalMs);
  }

  private _clearL2Timer(): void {
    if (this.l2Timer !== null) { clearTimeout(this.l2Timer); this.l2Timer = null; }
  }

  private async _runL2IfNeeded(manager: OffloadStateManager, reason: string): Promise<void> {
    if (this.l2Running) {
      this.logger.info(`[offload] [l2] skipped reason=already_running session=${manager.ctx.sessionKey}`);
      return;
    }
    if (!this.config.l2Enabled) {
      this.logger.info(`[offload] [l2] skipped reason=disabled session=${manager.ctx.sessionKey}`);
      return;
    }
    if (!this.llmClient) {
      this.logger.info(`[offload] [l2] skipped reason=no_model session=${manager.ctx.sessionKey}`);
      return;
    }
    this.l2Running = true;
    this.logger.info(`[offload] [l2] trigger reason=${reason} session=${manager.ctx.sessionKey}`);

    // ─── Wait-entry retry (Phase 4): check for "wait" entries before normal trigger ──
    try {
      if (this.waitRetryFeatureGate) {
        const allEntries = await readAllOffloadEntries(manager.ctx);
        const waitEntries = allEntries.filter((e) => e.node_id === "wait");
        if (waitEntries.length > 0) {
          const oldestWait = waitEntries.reduce((oldest, e) =>
            (e.timestamp && (!oldest.timestamp || e.timestamp < oldest.timestamp)) ? e : oldest,
            waitEntries[0]!,
          );
          const waitAgeSec = (Date.now() - new Date(oldestWait.timestamp!).getTime()) / 1000;
          if (waitAgeSec >= this.config.l2WaitRetrySeconds) {
            this.logger.info(`[offload] [l2] wait_retry: ${waitEntries.length} wait entries, oldest ${waitAgeSec.toFixed(0)}s old (threshold ${this.config.l2WaitRetrySeconds}s)`);
            // Clear wait entries to "null" so they get picked up by L2 processing
            for (const e of allEntries) {
              if (e.node_id === "wait") e.node_id = null;
            }
            // Rewrite the entries back to disk
            await rewriteAllOffloadEntries(manager.ctx, allEntries);
            this.logger.info(`[offload] [l2] wait_retry: reset ${waitEntries.length} entries from "wait" to null, triggering L2`);
            const result = await checkL2Trigger(manager, this._toPluginConfig(), this.logger);
            if (result.shouldTrigger) {
              await this._runL2Pipeline(manager, result.entriesByMmd, "wait_retry");
            } else {
              this.logger.info(`[offload] [l2] wait_retry: no trigger after reset (expected if wait entries were already retried)`);
            }
            this.l2Running = false;
            return;
          } else {
            this.logger.info(`[offload] [l2] wait_retry: ${waitEntries.length} wait entries found, oldest ${waitAgeSec.toFixed(0)}s old (not yet >= ${this.config.l2WaitRetrySeconds}s)`);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[offload] [l2] wait_retry check failed: ${err}`);
    }

    try {
      const result = await checkL2Trigger(manager, this._toPluginConfig(), this.logger);
      if (!result.shouldTrigger) {
        this.logger.info(`[offload] [l2] skipped reason=no_trigger session=${manager.ctx.sessionKey}`);
        return;
      }
      await this._runL2Pipeline(manager, result.entriesByMmd, reason);
    } catch (err) { this.logger.error(`[offload] L2 check error: ${err}`); }
    finally {
      this.l2Running = false;
      try {
        const allEntries = await readAllOffloadEntries(manager.ctx);
        if (allEntries.filter((e) => e.node_id === null).length >= this.config.l2NullThreshold) this._scheduleL2Check(manager, "recheck");
      } catch { /* ignore */ }
    }
  }

  // ─── Step 35n: L2 pipeline — Generate MMD files from offload entries ─
  private async _runL2Pipeline(manager: OffloadStateManager, entriesByMmd: Map<string, any[]>, triggerSource: string): Promise<void> {
    const llmClient = this.llmClient;
    if (!llmClient) return;
    for (const [mmdFile, mmdEntries] of entriesByMmd) {
      const taskLabel = mmdFile.replace(/^\d+-/, "").replace(/\.mmd$/, "") || "unnamed-task";
      const prefixMatch = mmdFile.match(/^(\d+)-/);
      const mmdPrefix = (prefixMatch?.[1]) ?? "000";
      const batches: any[][] = [];
      for (let i = 0; i < mmdEntries.length; i += this.config.maxPairsPerBatch) batches.push(mmdEntries.slice(i, i + this.config.maxPairsPerBatch));

      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        const batch = batches[bIdx]!;
        const batchWaitIds = new Set(batch.map((e: any) => e.tool_call_id as string));
        const existingMmd = await readMmd(manager.ctx, mmdFile);

        const req: L2Request = {
          existingMmd, newEntries: batch.map((e: any) => ({ tool_call_id: e.tool_call_id, tool_call: e.tool_call, summary: e.summary, timestamp: e.timestamp })),
          recentHistory: manager.cachedRecentHistory ?? null, currentTurn: manager.cachedLatestTurnMessages ?? null,
          taskLabel, mmdPrefix, mmdCharCount: existingMmd ? existingMmd.length : 0,
        };

        await backfillNodeIds(manager.ctx, {}, batchWaitIds, this.logger, { mmdFallbackText: existingMmd ?? "", mmdPrefix }); // Mark as "wait"
        if (bIdx === 0) { manager.setLastL2TriggerTime(new Date().toISOString()); await manager.save(); }

        try {
          const resp = await llmClient.l2Generate(req);
          if (resp.fileAction === "replace" && resp.replaceBlocks?.length) {
            const patchOk = await patchMmd(manager.ctx, mmdFile, resp.replaceBlocks);
            if (!patchOk && resp.mmdContent) await writeMmd(manager.ctx, mmdFile, resp.mmdContent);
          } else if (resp.mmdContent) await writeMmd(manager.ctx, mmdFile, resp.mmdContent);
          const mmdAfterWrite = await readMmd(manager.ctx, mmdFile);
          await backfillNodeIds(manager.ctx, resp.nodeMapping ?? {}, batchWaitIds, this.logger, { mmdFallbackText: mmdAfterWrite ?? existingMmd ?? "", mmdPrefix });

          // ─── Phase 5: Check MMD completion → signal scene resolution ──
          if (mmdAfterWrite && this.coordination) {
            const allDone = !/status:\s*(doing|todo)/i.test(mmdAfterWrite);
            if (allDone) {
              // Extract label from mmdFile (strip prefix and extension)
              const label = mmdFile.replace(/^\d+-/, "").replace(/\.mmd$/, "");
              this.coordination.onMmdCompleted(manager.ctx.sessionKey, label).catch((err: unknown) =>
                this.logger.warn(`[offload] coordination.onMmdCompleted failed: ${err}`),
              );
            }
          }
        } catch (err) { this.logger.error(`[offload] L2 ${mmdFile} batch ${bIdx + 1}/${batches.length} failed: ${err}`); }
      }
    }
  }

  private _toPluginConfig(): Partial<PluginConfig> {
    return { model: this.config.model, temperature: this.config.temperature, forceTriggerThreshold: this.config.forceTriggerThreshold,
      maxPairsPerBatch: this.config.maxPairsPerBatch, l2NullThreshold: this.config.l2NullThreshold, l2TimeoutSeconds: this.config.l2TimeoutSeconds,
      mildOffloadRatio: this.config.mildOffloadRatio, aggressiveCompressRatio: this.config.aggressiveCompressRatio,
      emergencyCompressRatio: this.config.emergencyCompressRatio, emergencyTargetRatio: this.config.emergencyTargetRatio,
      aggressiveDeleteRatio: this.config.aggressiveDeleteRatio, mildOffloadScanRatio: this.config.mildOffloadScanRatio,
      mmdMaxTokenRatio: this.config.mmdMaxTokenRatio, defaultContextWindow: this.config.contextWindow };
  }

  // ─── Step 35o: MMD size guard — Truncate oversized MMD files ─────────
  //  Called before MMD injection in beforeTurn and onStepFinish.
  //  If the active MMD exceeds the token budget, truncate it to fit.
  private async guardMmdSize(manager: OffloadStateManager): Promise<void> {
    if (!this.config.l2Enabled) return;

    const activeMmdFile = manager.getActiveMmdFile();
    if (!activeMmdFile) return;

    try {
      const mmdContent = await readMmd(manager.ctx, activeMmdFile);
      if (!mmdContent) return;

      const countTokens = createL3TokenCounter(this._toPluginConfig(), this.logger);
      const tokenCount = countTokens(mmdContent);
      const maxTokens = Math.floor(this.config.contextWindow * this.config.mmdMaxTokenRatio);

      if (tokenCount > maxTokens) {
        this.logger.info(`[offload] MMD size guard: session=${manager.ctx.sessionKey}, activeMmd=${activeMmdFile}, tokens=${tokenCount}, max=${maxTokens} — truncating`);

        // Truncate: take the first portion that fits within budget
        const truncated = await this.truncateMmdContent(mmdContent, maxTokens);
        if (truncated && truncated !== mmdContent) {
          await writeMmd(manager.ctx, activeMmdFile, truncated);
          this.logger.info(`[offload] MMD size guard: truncated ${activeMmdFile} from ${mmdContent.length} chars to ${truncated.length} chars`);
        }
      }
    } catch (err) {
      this.logger.warn(`[offload] MMD size guard failed: ${err}`);
    }
  }

  /**
   * Truncate MMD content to fit within the token budget.
   * Strategy: progressively remove the oldest (lowest priority) nodes from
   * the MMD until it fits. If that's not possible, truncate to first N characters.
   */
  private async truncateMmdContent(mmdContent: string, maxTokens: number): Promise<string | null> {
    const countTokens = createL3TokenCounter(this._toPluginConfig(), this.logger);

    // Quick check: estimate tokens roughly (4 chars per token for Mermaid diagrams)
    const estimatedTokens = countTokens(mmdContent);
    if (estimatedTokens <= maxTokens) return mmdContent;

    // Try to drop non-essential lines (comment lines, empty lines) first
    const lines = mmdContent.split("\n");
    const essentialLines = lines.filter((l) => l.trim() && !l.trim().startsWith("%%"));
    if (essentialLines.length > 0 && countTokens(essentialLines.join("\n")) <= maxTokens) {
      return essentialLines.join("\n");
    }

    // Last resort: take first N tokens worth of content
    // Rough character-to-token approximation (4 chars ≈ 1 token for Mermaid)
    const maxChars = maxTokens * 4;
    if (mmdContent.length > maxChars) {
      // Try to cut at a line boundary
      const truncatedLines: string[] = [];
      let charCount = 0;
      for (const line of lines) {
        if (charCount + line.length + 1 > maxChars) break;
        truncatedLines.push(line);
        charCount += line.length + 1;
      }
      if (truncatedLines.length > 0) {
        truncatedLines.push("%% -- truncated by MMD size guard --");
        return truncatedLines.join("\n");
      }
    }

    return null;
  }

  // ─── Step 35p: Run reclaim on demand — called by /offload-reclaim admin command ─
  async runReclaim(): Promise<ReclaimStats | null> {
    if (!this.enabled || !this.reclaimFeatureGate || this.retentionDays < 3) return null;
    try {
      const stats: ReclaimStats = await reclaimOffloadData(this.getDataDir(), {
        retentionDays: this.retentionDays,
        logMaxSizeMb: this.config.logMaxSizeMb,
      }, this.logger);
      this.logger.info(`[offload] runReclaim: jsonl=${stats.deletedJsonl}, refs=${stats.deletedRefs}, mmds=${stats.deletedMmds}, logs=${stats.truncatedLogs}, registry=${stats.prunedRegistryEntries}`);
      return stats;
    } catch (err) {
      this.logger.error(`[offload] runReclaim error: ${err}`);
      return null;
    }
  }
}

// ─── Constants ───────────────────────────────────────────────────────────
const L15_MIN_CHARS_FOR_JUDGE = 20;
const L15_RETRY_DELAY_MS = 3000;
const RECLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ─── L4 System prompt ────────────────────────────────────────────────────
const L4_SYSTEM_PROMPT = `You generate Codex skill documents from completed task context.\n\nReturn only valid JSON with this exact shape:\n{\n  "skillName": "kebab-case-directory-name",\n  "skillDescription": "one sentence description",\n  "skillContent": "# Skill Name\\n\\n...\"\n}\n\nThe skillContent must be a complete SKILL.md. Include when to use the skill, concrete workflow steps, constraints, edge cases, and verification steps. Keep it reusable and do not include private credentials or irrelevant chat history.`;

// ─── Helper functions ─────────────────────────────────────────────────────
function parseCreateSkillCommand(prompt: string): CreateSkillCommand | null {
  if (typeof prompt !== "string") return null;
  const match = prompt.trim().match(/^\/create-skill(?:\s+(.*))?$/i);
  if (!match) return null;
  const args = (match[1] || "").trim();
  if (!args) return { mmdName: null, skillFocus: null };
  const parts = args.split(/\s+/);
  return { mmdName: parts[0] || null, skillFocus: parts.slice(1).join(" ") || null };
}

function selectMmdFilename(allMmds: string[], activeMmd: string | null, requestedName: string | null): string | null {
  if (requestedName) {
    const needle = requestedName.toLowerCase();
    return allMmds.find((f) => f.toLowerCase() === needle) ?? allMmds.find((f) => f.toLowerCase().includes(needle)) ?? null;
  }
  if (activeMmd && allMmds.includes(activeMmd)) return activeMmd;
  return allMmds.length > 0 ? allMmds[allMmds.length - 1]! : null;
}

function extractNodeIds(mmdContent: string): Set<string> {
  const ids = new Set<string>();
  const nodeIdPattern = /\b(\d{3}-N\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = nodeIdPattern.exec(mmdContent)) !== null) ids.add(match[1]!);
  return ids;
}

function buildL4UserPrompt(req: { mmdFilename: string; mmdContent: string; offloadEntries: OffloadEntry[]; skillFocus: string | null }): string {
  const entries = req.offloadEntries.map((e, idx) => ({ index: idx + 1, tool_call_id: e.tool_call_id, node_id: e.node_id, tool_call: e.tool_call, summary: e.summary, timestamp: e.timestamp }));
  return JSON.stringify({ mmdFilename: req.mmdFilename, skillFocus: req.skillFocus, mmdContent: req.mmdContent, offloadEntries: entries }, null, 2);
}

function parseL4Response(raw: string): { skillName: string; skillDescription: string; skillContent: string } | null {
  const jsonText = extractJson(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed.skillName !== "string" || typeof parsed.skillDescription !== "string" || typeof parsed.skillContent !== "string") return null;
    return { skillName: parsed.skillName, skillDescription: parsed.skillDescription, skillContent: parsed.skillContent };
  } catch { return null; }
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
  return (name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)) || `generated-skill-${Date.now()}`;
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

// ─── OpenAI format converter for onStepFinish ────────────────────────────
function ensureOpenAIFormat(messages: unknown[]): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const contentArr = m.content;
    if (!Array.isArray(contentArr) || contentArr.length === 0) continue;
    const textParts: string[] = [];
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    for (const block of contentArr as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
      else if (block.type === "tool-call") toolCalls.push({ id: String(block.toolCallId ?? ""), type: "function", function: { name: String(block.toolName ?? ""), arguments: typeof block.args === "string" ? block.args : JSON.stringify(block.args ?? {}) } });
    }
    m.content = textParts.join("");
    if (toolCalls.length > 0) m.tool_calls = toolCalls;
  }
}
