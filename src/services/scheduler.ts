// ═══════════════════════════════════════════════════════════════════════
//  [Step 42]  SCHEDULER — Autonomous Catch-Up Trigger Engine
//  ═══════════════════════════════════════════════════════════════════════
//  Evaluates trigger conditions for L2 scene extraction and L3 persona
//  generation. Operates in three phases:
//    "none":    no code runs (scheduler is a no-op)
//    "observer": evaluates conditions, logs decisions, never dispatches
//    "active":  evaluates conditions and dispatches jobs
//
//  Spec reference: Sections 5.2, 5.4, 14
// ═══════════════════════════════════════════════════════════════════════

import type { MemoryAutonomyCheckpoint, MemoryCheckpointState } from "../memory/autonomy-checkpoint.ts";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { FeatureGates } from "../memory/build-memory-config.ts";
import { PollingBridge, type PollingBridgeCallbacks } from "./polling-bridge.ts";
import path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export type SchedulerPhase = "none" | "observer" | "active";

export interface SchedulerConfig {
  l2ForceAfterIdleSeconds: number;
  l2StartupRecoveryDelaySeconds: number;
  l2StaleRefreshHours: number;
  l2MinInterval: number;
  l2MaxInterval: number;
  personaMaxStaleHours: number;
  personaMinScenes: number;
  personaMinChangedScenes: number;
  personaTriggerN: number;
  sessionWindowHours: number;
  globalConcurrencyLimit: number;
  coldSessionCleanupIntervalMs: number;
  coldSessionTimeoutMs: number;
  featureGates: FeatureGates;
}

export interface MemoryPipeline {
  runL2(sessionKey: string): Promise<void>;
  runPersona(sessionKey: string): Promise<void>;
  getSceneCount(sessionKey: string): Promise<number>;
  runSceneMaintenance?(sessionKey: string): Promise<{
    staleTransitions: number;
    archiveTransitions: number;
    dedupCandidates: number;
  }>;
}

export interface SchedulerDeps {
  checkpoint: MemoryAutonomyCheckpoint;
  pipeline: MemoryPipeline;
  logger: Logger;
  config: SchedulerConfig;
}

// ── Trigger decision results ──────────────────────────────────────────────

export type L2TriggerDecision = {
  shouldTrigger: boolean;
  reason: string;
  triggerType: "force_after_idle" | "first_scene" | "stale_refresh" | "startup_recovery" | "delay_after_l1" | "max_interval" | null;
};

export type PersonaTriggerDecision = {
  shouldTrigger: boolean;
  reason: string;
  triggerType: "missing" | "empty" | "first_scene" | "threshold" | "stale" | "explicit" | null;
};

// ── L2TriggerDelegate (for Phase 3 vendor edit) ───────────────────────────
//  One-time vendor edit interface to replace the polling bridge.
//  Implemented by Scheduler, consumed by MemoryPipelineManager.
//  This interface lives here as the contract; the vendor edit adds the
//  delegate as an optional constructor param to MemoryPipelineManager.
//  See: docs/plans/phase-scheduler-migration.md Task 3 Step 1
export interface L2TriggerDelegate {
  onL1Completed(sessionKey: string): void;
  onSessionActivity(sessionKey: string): void;
  onShutdown(): Promise<void>;
}

// ── Queued job entry for global concurrency limiter ────────────────────────
interface QueuedJob {
  sessionKey: string;
  label: string;
  run: () => Promise<void>;
}

// ── Scheduler Class ───────────────────────────────────────────────────────

export class Scheduler {
  private readonly phase: SchedulerPhase;
  private readonly deps: SchedulerDeps;
  private readonly startupRecovered = new Set<string>();
  private staleRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private coldSessionTimer: ReturnType<typeof setInterval> | null = null;
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimers: ReturnType<typeof setTimeout>[] = [];
  private pollingBridge: PollingBridge | null = null;
  private closed = false;

  // Global concurrency limiter
  private runningJobs = 0;
  private readonly jobQueue: QueuedJob[] = [];

  constructor(deps: SchedulerDeps, phase: SchedulerPhase) {
    this.deps = deps;
    this.phase = phase;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Called on every user message. Updates activity timestamp and resets cold flag.
   * Runs in all phases (always updates checkpoint).
   */
  async notifyActivity(sessionKey: string): Promise<void> {
    if (this.phase === "none" || this.closed) return;

    const now = new Date().toISOString();
    await this.deps.checkpoint.updateState(sessionKey, {
      sessionLastActiveAt: now,
      sessionIsCold: false,
    });

    this.deps.logger.debug(`[scheduler] notify_activity session=${sessionKey}`);
  }

  /**
   * Called when L1 extraction finishes. Updates sequencing counters and
   * evaluates whether to dispatch L2.
   */
  async onL1Completed(sessionKey: string, count?: number): Promise<void> {
    if (this.phase === "none" || this.closed) return;

    const state = await this.deps.checkpoint.getState(sessionKey);
    const delta = Math.max(1, count ?? 1);
    await this.deps.checkpoint.updateState(sessionKey, {
      lastL1CompletedAt: new Date().toISOString(),
      lastMemorySeqExtracted: state.lastMemorySeqExtracted + delta,
    });

    this.deps.logger.debug(`[scheduler] L1_completed session=${sessionKey} delta=${delta}`);
    await this.evaluateAndDispatchL2(sessionKey, "delay_after_l1");
  }

  /**
   * Core L2 trigger decision logic. Evaluates all trigger conditions in
   * priority order. In observer mode, logs the decision without dispatching.
   */
  async evaluateAndDispatchL2(sessionKey: string, triggerContext: string): Promise<L2TriggerDecision> {
    if (this.phase === "none" || this.closed) {
      return { shouldTrigger: false, reason: "scheduler_disabled", triggerType: null };
    }

    const state = await this.deps.checkpoint.getState(sessionKey);
    const cfg = this.deps.config;
    const now = Date.now();

    // ── Check skip conditions first ─────────────────────────────────

    // Skip if no pending work
    const pendingCount = state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2;
    if (pendingCount <= 0) {
      const decision: L2TriggerDecision = { shouldTrigger: false, reason: "no_pending_work", triggerType: null };
      await this.logL2Decision(sessionKey, decision, state);
      return decision;
    }



    // Skip if L2 already running or scheduled (double-fire guard)
    if (state.l2JobStatus !== "idle") {
      const decision: L2TriggerDecision = { shouldTrigger: false, reason: `l2_job_status_${state.l2JobStatus}`, triggerType: null };
      await this.logL2Decision(sessionKey, decision, state);
      return decision;
    }

    // Skip if min interval not elapsed (unless forced by startup recovery)
    if (state.lastL2CompletedAt && triggerContext !== "startup_recovery") {
      const msSinceL2 = now - new Date(state.lastL2CompletedAt).getTime();
      if (msSinceL2 < cfg.l2MinInterval * 1000) {
        const decision: L2TriggerDecision = { shouldTrigger: false, reason: "min_interval_not_elapsed", triggerType: null };
        await this.logL2Decision(sessionKey, decision, state);
        return decision;
      }
    }

    // Skip if cold session and this is background/periodic maintenance (not user-triggered)
    if (state.sessionIsCold && (triggerContext === "stale_refresh" || triggerContext === "periodic")) {
      const decision: L2TriggerDecision = { shouldTrigger: false, reason: "cold_session", triggerType: null };
      await this.logL2Decision(sessionKey, decision, state);
      return decision;
    }

    // ── Check trigger conditions in priority order ──────────────────

    // 1. Force-after-idle (pending work and idle time exceeded)
    if (cfg.featureGates.l2ForceAfterIdle && state.lastL1CompletedAt) {
      const msSinceL1 = now - new Date(state.lastL1CompletedAt).getTime();
      if (msSinceL1 >= cfg.l2ForceAfterIdleSeconds * 1000) {
        return this.dispatchL2(sessionKey, "force_after_idle", state);
      }
    }

    // 2. Low-volume first scene (meaningful memory exists, no scenes yet)
    if (state.lastMeaningfulMemoryAt && state.sceneIndexUpdatedAt === null) {
      const sceneCount = await this.deps.pipeline.getSceneCount(sessionKey);
      if (sceneCount === 0) {
        return this.dispatchL2(sessionKey, "first_scene", state);
      }
    }

    // 3. Stale refresh (scene index old and session active)
    if (cfg.featureGates.l2StaleRefresh && state.sceneIndexUpdatedAt && !state.sessionIsCold) {
      const msSinceSceneUpdate = now - new Date(state.sceneIndexUpdatedAt).getTime();
      if (msSinceSceneUpdate >= cfg.l2StaleRefreshHours * 3600 * 1000) {
        return this.dispatchL2(sessionKey, "stale_refresh", state);
      }
    }

    // 4. Max interval elapsed (force L2 when enough time has passed since last L2)
    //    Note: force-after-idle typically fires before this (900s vs 1800s defaults),
    //    but this serves as a safety net for long intervals without L1 activity.
    if (state.lastL2CompletedAt) {
      const msSinceL2 = now - new Date(state.lastL2CompletedAt).getTime();
      if (msSinceL2 >= cfg.l2MaxInterval * 1000) {
        return this.dispatchL2(sessionKey, "max_interval", state);
      }
    }

    // 5. Standard delay-after-L1 — triggered when L1 just completed.
    //    The min_interval skip above already prevents running too soon after
    //    last L2. No additional timing check needed because onL1Completed
    //    already signals that new L1 data is ready for processing.
    if (triggerContext === "delay_after_l1") {
      return this.dispatchL2(sessionKey, "delay_after_l1", state);
    }

    // 6. Startup recovery (pending work and just booted)
    if (cfg.featureGates.l2StartupRecovery && !this.startupRecovered.has(sessionKey) && pendingCount > 0) {
      this.startupRecovered.add(sessionKey);
      return this.dispatchL2(sessionKey, "startup_recovery", state);
    }


    // No trigger condition met
    const decision: L2TriggerDecision = { shouldTrigger: false, reason: "no_trigger_condition_met", triggerType: null };
    await this.logL2Decision(sessionKey, decision, state);
    return decision;
  }

  /**
   * Core persona trigger decision logic.
   */
  async evaluateAndDispatchPersona(sessionKey: string): Promise<PersonaTriggerDecision> {
    if (this.phase === "none" || this.closed) {
      return { shouldTrigger: false, reason: "scheduler_disabled", triggerType: null };
    }

    const state = await this.deps.checkpoint.getState(sessionKey);
    const cfg = this.deps.config;
    const now = Date.now();
    const sceneCount = await this.deps.pipeline.getSceneCount(sessionKey);

    // ── Check skip conditions ─────────────────────────────────

    // Skip if no scenes
    if (sceneCount < cfg.personaMinScenes) {
      const decision: PersonaTriggerDecision = { shouldTrigger: false, reason: "no_scenes", triggerType: null };
      await this.logPersonaDecision(sessionKey, decision, state);
      return decision;
    }

    // Skip if already running
    if (state.personaJobStatus === "running") {
      const decision: PersonaTriggerDecision = { shouldTrigger: false, reason: "already_running", triggerType: null };
      await this.logPersonaDecision(sessionKey, decision, state);
      return decision;
    }

    // ── Check trigger conditions ───────────────────────────────

    // 0. Compute meaningful deltas
    const unprocessedMemoriesSinceL2 = state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2;
    const unprocessedScenesSincePersona = state.lastSceneSeqExtracted - state.lastSceneSeqProcessedByPersona;

    // 1. Missing persona (no persona and scenes exist, gate enabled)
    if (cfg.featureGates.personaForceIfMissing && !state.lastPersonaAt) {
      return this.dispatchPersona(sessionKey, "missing", state);
    }

    // 2. First scene exists and unprocessed scenes since last persona
    //    "first scene exists" = at least one scene has been extracted
    //    "unprocessed scenes since last persona > 0" = there are new scenes to process
    if (state.lastSceneSeqExtracted > 0 && unprocessedScenesSincePersona > 0) {
      return this.dispatchPersona(sessionKey, "first_scene", state);
    }

    // 3. Threshold reached (memories since L2 >= trigger N)
    if (unprocessedMemoriesSinceL2 >= cfg.personaTriggerN) {
      return this.dispatchPersona(sessionKey, "threshold", state);
    }

    // 4. Stale persona (age >= maxStaleHours and new memories since persona)
    //    Uses memory-based delta instead of scene delta to avoid deadlock with
    //    the first_scene trigger (which uses scene delta at higher priority).
    //    This measures "any new content since last L2" (approximation for content
    //    since last persona). See docs/specs/2026-05-26-memory-offload-long-term-design.md §5.4
    if (cfg.featureGates.personaStaleRefresh && state.lastPersonaAt) {
      const ageHours = (now - new Date(state.lastPersonaAt).getTime()) / 3_600_000;
      const newMemoriesSinceLastL2 = Math.max(0, state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2);
      if (ageHours >= cfg.personaMaxStaleHours && newMemoriesSinceLastL2 >= cfg.personaMinChangedScenes) {
        return this.dispatchPersona(sessionKey, "stale", state);
      }
    }

    // No trigger condition met
    const decision: PersonaTriggerDecision = { shouldTrigger: false, reason: "no_trigger_condition_met", triggerType: null };
    await this.logPersonaDecision(sessionKey, decision, state);
    return decision;
  }

  /**
   * Start polling bridge (Phase 2). Reads checkpoint file at configurable
   * interval to detect L1 completions and session activity.
   */
  startPollingBridge(dataDir: string): void {
    if (this.phase === "none" || this.closed) return;

    const checkpointFile = path.join(dataDir, ".metadata", "recall_checkpoint.json");
    this.pollingBridge = new PollingBridge(
      checkpointFile,
      {
        onL1Completed: (sk, count) => {
          this.onL1Completed(sk, count).catch((err) => {
            this.deps.logger.error(`[scheduler] polling_bridge L1 completed failed for ${sk}: ${err}`);
          });
        },
        onSessionActivity: (sk) => {
          this.notifyActivity(sk).catch((err) => {
            this.deps.logger.error(`[scheduler] polling_bridge activity failed for ${sk}: ${err}`);
          });
        },
      },
      2000, // poll interval (2 seconds)
    );
    this.pollingBridge.start();

    this.deps.logger.info(`[scheduler] polling_bridge started phase=${this.phase}`);
  }

  /**
   * Boot-time recovery: scan all sessions for pending L2 work and schedule
   * L2 after the configured delay.
   */
  async scheduleStartupRecovery(): Promise<void> {
    if (this.phase === "none" || this.closed) return;

    this.deps.logger.info("[scheduler] startup_recovery: scanning sessions for pending work");

    const allStates = await this.deps.checkpoint.getAllStates();
    const pendingSessions: Array<{ sessionKey: string; pendingCount: number }> = [];

    for (const [sessionKey, state] of Object.entries(allStates)) {
      const pending = state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2;
      if (pending > 0 && state.l2JobStatus === "idle") {
        pendingSessions.push({ sessionKey, pendingCount: pending });
      }
    }

    if (pendingSessions.length === 0) {
      this.deps.logger.info("[scheduler] startup_recovery: no pending sessions found");
      return;
    }

    this.deps.logger.info(
      `[scheduler] startup_recovery: scheduling L2 for ${pendingSessions.length} session(s) ` +
      `after ${this.deps.config.l2StartupRecoveryDelaySeconds}s delay`,
    );

    const delayMs = this.deps.config.l2StartupRecoveryDelaySeconds * 1000;
    for (const { sessionKey } of pendingSessions) {
      const timer = setTimeout(() => {
        this.evaluateAndDispatchL2(sessionKey, "startup_recovery").catch((err) => {
          this.deps.logger.error(`[scheduler] startup_recovery L2 failed for ${sessionKey}: ${err}`);
        });
      }, delayMs);
      this.startupTimers.push(timer);
    }
  }

  /**
   * Start the stale refresh interval timer. Checks all sessions periodically.
   */
  scheduleStaleRefreshTimer(): void {
    if (this.phase === "none" || this.closed) return;

    const intervalMs = Math.min(this.deps.config.l2StaleRefreshHours * 3600 * 1000 / 2, 3600_000); // Check at most hourly
    this.staleRefreshTimer = setInterval(() => {
      this.runStaleRefreshCheck().catch((err) => {
        this.deps.logger.error(`[scheduler] stale_refresh check failed: ${err}`);
      });
    }, intervalMs);

    this.deps.logger.info(`[scheduler] stale_refresh timer started (interval=${intervalMs}ms)`);
  }

  /**
   * Start the cold session cleanup timer.
   */
  scheduleColdSessionCleanup(): void {
    if (this.phase === "none" || this.closed) return;

    this.coldSessionTimer = setInterval(() => {
      this.runColdSessionCleanup().catch((err) => {
        this.deps.logger.error(`[scheduler] cold_session cleanup failed: ${err}`);
      });
    }, this.deps.config.coldSessionCleanupIntervalMs);

    this.deps.logger.info(`[scheduler] cold_session cleanup timer started (interval=${this.deps.config.coldSessionCleanupIntervalMs}ms)`);
  }

  /**
   * Start the periodic evaluation timer. Runs every 60 seconds to re-evaluate
   * L2 trigger conditions for all sessions. This is the main loop that catches
   * timing-based triggers (force_after_idle, max_interval) after the initial
   * evaluation from onL1Completed.
   */
  schedulePeriodicEvaluation(): void {
    if (this.phase === "none" || this.closed) return;

    // 60s interval ensures timing-based triggers (force_after_idle at 900s default,
    // max_interval at 1800s default) are caught within ~1 minute of becoming eligible.
    // Hardcoded because the evaluation is lightweight (read + skip) and this interval
    // doesn't need per-deployment tuning — it simply needs to be shorter than the
    // shortest timing trigger (force_after_idle at 900s).
    this.evaluationTimer = setInterval(() => {
      this.runPeriodicEvaluation().catch((err) => {
        this.deps.logger.error(`[scheduler] periodic_evaluation failed: ${err}`);
      });
    }, 60_000);

    this.deps.logger.info("[scheduler] periodic_evaluation timer started (interval=60000ms)");
  }

  /**
   * Graceful shutdown: clear all timers and stop polling bridge.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.staleRefreshTimer !== null) {
      clearInterval(this.staleRefreshTimer);
      this.staleRefreshTimer = null;
    }
    if (this.coldSessionTimer !== null) {
      clearInterval(this.coldSessionTimer);
      this.coldSessionTimer = null;
    }
    if (this.evaluationTimer !== null) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    for (const timer of this.startupTimers) {
      clearTimeout(timer);
    }
    this.startupTimers = [];
    if (this.pollingBridge !== null) {
      this.pollingBridge.close();
      this.pollingBridge = null;
    }
    this.deps.logger.info("[scheduler] closed");
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async dispatchL2(sessionKey: string, triggerType: L2TriggerDecision["triggerType"], state: MemoryCheckpointState): Promise<L2TriggerDecision> {
    const decision: L2TriggerDecision = {
      shouldTrigger: true,
      reason: triggerType!,
      triggerType,
    };
    await this.logL2Decision(sessionKey, decision, state);

    if (this.phase === "active") {
      // Mark as scheduled atomically before enqueueing (double-fire guard)
      await this.deps.checkpoint.updateState(sessionKey, { l2JobStatus: "scheduled" });

      // Enqueue through the global concurrency limiter
      this.enqueueJob(sessionKey, "L2", async () => {
        // Update to running before dispatching
        await this.deps.checkpoint.updateState(sessionKey, { l2JobStatus: "running" });
        try {
          await this.deps.pipeline.runL2(sessionKey);

          // Run scene maintenance after L2 (stale/archive transitions, dedup)
          if (this.deps.pipeline.runSceneMaintenance) {
            const maintenance = await this.deps.pipeline.runSceneMaintenance(sessionKey);
            if (maintenance.staleTransitions > 0 || maintenance.archiveTransitions > 0 || maintenance.dedupCandidates > 0) {
              this.deps.logger.info(
                `[scheduler] scene_maintenance session=${sessionKey} ` +
                `stale=${maintenance.staleTransitions} ` +
                `archived=${maintenance.archiveTransitions} ` +
                `dedup=${maintenance.dedupCandidates}`,
              );
            }
          }

          const newState = await this.deps.checkpoint.getState(sessionKey);
          await this.deps.checkpoint.updateState(sessionKey, {
            lastL2CompletedAt: new Date().toISOString(),
            lastMemorySeqProcessedByL2: newState.lastMemorySeqExtracted,
            l2JobStatus: "idle",
          });
        } catch (err) {
          this.deps.logger.error(`[scheduler] L2 dispatch failed for ${sessionKey}: ${err}`);
          await this.deps.checkpoint.updateState(sessionKey, { l2JobStatus: "idle" });
        }
      });
    }

    return decision;
  }

  private async dispatchPersona(sessionKey: string, triggerType: PersonaTriggerDecision["triggerType"], state: MemoryCheckpointState): Promise<PersonaTriggerDecision> {
    const decision: PersonaTriggerDecision = {
      shouldTrigger: true,
      reason: triggerType!,
      triggerType,
    };
    await this.logPersonaDecision(sessionKey, decision, state);

    if (this.phase === "active") {
      // Mark as running (atomic guard)
      await this.deps.checkpoint.updateState(sessionKey, { personaJobStatus: "running" });

      // Enqueue through the global concurrency limiter
      this.enqueueJob(sessionKey, "persona", async () => {
        try {
          await this.deps.pipeline.runPersona(sessionKey);
          const newState = await this.deps.checkpoint.getState(sessionKey);
          await this.deps.checkpoint.updateState(sessionKey, {
            lastPersonaAt: new Date().toISOString(),
            lastSceneSeqProcessedByPersona: newState.lastSceneSeqExtracted,
            personaJobStatus: "idle",
          });
        } catch (err) {
          this.deps.logger.error(`[scheduler] persona dispatch failed for ${sessionKey}: ${err}`);
          await this.deps.checkpoint.updateState(sessionKey, { personaJobStatus: "idle" });
        }
      });
    }

    return decision;
  }

  private async logL2Decision(sessionKey: string, decision: L2TriggerDecision, state: MemoryCheckpointState): Promise<void> {
    const prefix = this.phase === "observer" ? "[scheduler] [observer] L2" : "[scheduler] L2";
    if (decision.shouldTrigger) {
      this.deps.logger.info(`${prefix} trigger reason=${decision.reason} session=${sessionKey}`);
    } else {
      const pending = state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2;
      this.deps.logger.info(
        `${prefix} skip reason=${decision.reason} session=${sessionKey} pending=${pending}`,
      );
    }
  }

  private async logPersonaDecision(sessionKey: string, decision: PersonaTriggerDecision, state: MemoryCheckpointState): Promise<void> {
    const prefix = this.phase === "observer" ? "[scheduler] [observer] persona" : "[scheduler] persona";
    const unprocessedMemoriesSinceL2 = state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2;
    const unprocessedScenesSincePersona = state.lastSceneSeqExtracted - state.lastSceneSeqProcessedByPersona;
    if (decision.shouldTrigger) {
      this.deps.logger.info(`${prefix} trigger reason=${decision.reason} session=${sessionKey}`);
    } else {
      this.deps.logger.info(
        `${prefix} skip reason=${decision.reason} session=${sessionKey} ` +
        `memories_since_l2=${unprocessedMemoriesSinceL2} scenes_since_persona=${unprocessedScenesSincePersona}`,
      );
    }
  }

  private async runStaleRefreshCheck(): Promise<void> {
    const allStates = await this.deps.checkpoint.getAllStates();
    for (const sessionKey of Object.keys(allStates)) {
      await this.evaluateAndDispatchL2(sessionKey, "stale_refresh");
    }
  }

  private async runPeriodicEvaluation(): Promise<void> {
    const allStates = await this.deps.checkpoint.getAllStates();
    for (const sessionKey of Object.keys(allStates)) {
      await this.evaluateAndDispatchL2(sessionKey, "periodic");
    }
  }

  private async runColdSessionCleanup(): Promise<void> {
    const allStates = await this.deps.checkpoint.getAllStates();
    const now = Date.now();
    let coldCount = 0;
    let remainingCount = 0;

    for (const [sessionKey, state] of Object.entries(allStates)) {
      const lastActive = new Date(state.sessionLastActiveAt).getTime();
      if (now - lastActive > this.deps.config.coldSessionTimeoutMs) {
        await this.deps.checkpoint.updateState(sessionKey, { sessionIsCold: true });
        coldCount++;
      } else {
        remainingCount++;
      }
    }

    if (coldCount > 0) {
      this.deps.logger.info(`[scheduler] cleanup cold_sessions=${coldCount} remaining=${remainingCount}`);
    }
  }

  // ── Global Concurrency Limiter ───────────────────────────────────────────

  /**
   * Enqueue a job through the global concurrency limiter.
   * If the limit is not reached, runs immediately. Otherwise, queues
   * the job and drains when a slot opens.
   */
  private enqueueJob(sessionKey: string, label: string, run: () => Promise<void>): void {
    const job: QueuedJob = { sessionKey, label, run };

    if (this.runningJobs < this.deps.config.globalConcurrencyLimit) {
      this.runJob(job);
    } else {
      this.jobQueue.push(job);
      this.deps.logger.info(
        `[scheduler] queue session=${sessionKey} job=${label} ` +
        `depth=${this.jobQueue.length} running=${this.runningJobs}`,
      );
    }
  }

  /**
   * Execute a single job, then drain the queue.
   */
  private runJob(job: QueuedJob): void {
    this.runningJobs++;
    job.run().finally(() => {
      this.runningJobs--;
      this.drainQueue();
    });
  }

  /**
   * Drain the job queue: process as many queued jobs as the concurrency
   * limit allows, in FIFO order.
   */
  private drainQueue(): void {
    while (this.jobQueue.length > 0 && this.runningJobs < this.deps.config.globalConcurrencyLimit) {
      const next = this.jobQueue.shift()!;
      this.runJob(next);
    }
  }
}
