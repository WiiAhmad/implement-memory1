// ═══════════════════════════════════════════════════════════════════════
//  [Step 43]  POLLING BRIDGE — Checkpoint File Watcher for L2 Catch-Up Triggers
//  ═══════════════════════════════════════════════════════════════════════
//  Reads the TDAI checkpoint file at a configurable interval and detects
//  changes in pipeline_states that signal L1 completion or session activity.
//  Fires callbacks that map to the Scheduler's onL1Completed and notifyActivity.
//
//  This bridge enables Phase 2 of the scheduler migration: the new scheduler
//  takes over L2 trigger decisions by polling the checkpoint file that the
//  old MemoryPipelineManager writes to. No vendor edit required.
//
//  Spec reference: Sections 14.1-14.7 (Phase 2 migration)
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Callbacks fired by PollingBridge when checkpoint state changes.
 *
 * The names describe what the bridge detected, not what the scheduler does:
 *   onL1Completed  → scheduler.onL1Completed(sessionKey)
 *   onSessionActivity  → scheduler.notifyActivity(sessionKey)
 */
export interface PollingBridgeCallbacks {
  onL1Completed(sessionKey: string, count: number): void;
  onSessionActivity(sessionKey: string): void;

}

/**
 * Per-session previous state snapshot for change detection.
 */
interface SessionSnapshot {
  l1PendingCount: number;
  lastActiveTime: number;
}

// ─── PollingBridge Class ────────────────────────────────────────────────────

export class PollingBridge {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private previousState: Record<string, SessionSnapshot> = {};

  constructor(
    private readonly checkpointFile: string,
    private readonly callbacks: PollingBridgeCallbacks,
    private readonly pollIntervalMs: number = 2000,
  ) {}

  /**
   * Start the polling loop. Reads the checkpoint file at the configured interval
   * and fires callbacks when state changes are detected.
   */
  start(): void {
    if (this.closed) return;
    this.timer = setInterval(() => {
      this.poll().catch(() => {
        // Poll errors are non-fatal — skip this cycle
      });
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling and release resources.
   */
  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Single poll cycle: read checkpoint, compare with previous state, fire callbacks.
   */
  private async poll(): Promise<void> {
    if (this.closed) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.checkpointFile, "utf8");
    } catch {
      // File not found or not readable — skip this cycle
      return;
    }

    let cp: any;
    try {
      cp = JSON.parse(raw);
    } catch {
      // Parse error — skip this cycle
      return;
    }

    const pipelineStates = cp.pipeline_states ?? {};

    for (const [sessionKey, ps] of Object.entries(pipelineStates) as [string, any][]) {
      const current: SessionSnapshot = {
        l1PendingCount: ps.l2_pending_l1_count ?? 0,
        lastActiveTime: ps.last_active_time ?? 0,
      };

      const prev = this.previousState[sessionKey];
      if (prev) {
        // L1 completed: pending count increased — pass the delta so
        // the scheduler can increment the sequence counter accurately
        const delta = current.l1PendingCount - prev.l1PendingCount;
        if (delta > 0) {
          this.callbacks.onL1Completed(sessionKey, delta);
        }
        // Session activity: last_active_time advanced
        if (current.lastActiveTime > prev.lastActiveTime) {
          this.callbacks.onSessionActivity(sessionKey);
        }
      }

      this.previousState[sessionKey] = current;
    }
  }
}
