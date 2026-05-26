// ═══════════════════════════════════════════════════════════════════════
//  [Step 38]  MEMORY AUTONOMY CHECKPOINT — Namespaced Checkpoint for Autonomous Triggers
//  ═══════════════════════════════════════════════════════════════════════
//  Wraps the TDAI CheckpointManager to add a `memory_autonomy_state`
//  namespace alongside the existing `runner_states` and `pipeline_states`.
//  Provides per-session sequencing counters, timestamps, job guards, and
//  activity signals — the foundation for all catch-up trigger decisions.
//  ═══════════════════════════════════════════════════════════════════════

import { CheckpointManager } from "../../TencentDB-Agent-Memory/src/utils/checkpoint.ts";
import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

// ─── Type: Per-session memory autonomy state ─────────────────────────────
export interface MemoryCheckpointState {
  // Sequencing counters
  lastMemorySeqExtracted: number;
  lastMemorySeqProcessedByL2: number;
  lastSceneSeqExtracted: number;
  lastSceneSeqProcessedByPersona: number;

  // Timestamps (ISO-8601 or null)
  lastL1CompletedAt: string | null;
  lastL2CompletedAt: string | null;
  lastPersonaAt: string | null;
  lastMeaningfulMemoryAt: string | null;
  sceneIndexUpdatedAt: string | null;

  // Job guards
  l2JobStatus: "idle" | "running" | "scheduled";
  personaJobStatus: "idle" | "running";

  // Activity signals
  sessionLastActiveAt: string;
  sessionIsCold: boolean;
}

export const DEFAULT_AUTONOMY_STATE: MemoryCheckpointState = {
  lastMemorySeqExtracted: 0,
  lastMemorySeqProcessedByL2: 0,
  lastSceneSeqExtracted: 0,
  lastSceneSeqProcessedByPersona: 0,
  lastL1CompletedAt: null,
  lastL2CompletedAt: null,
  lastPersonaAt: null,
  lastMeaningfulMemoryAt: null,
  sceneIndexUpdatedAt: null,
  l2JobStatus: "idle",
  personaJobStatus: "idle",
  sessionLastActiveAt: new Date(0).toISOString(),
  sessionIsCold: false,
};

// ─── Class ───────────────────────────────────────────────────────────────
export class MemoryAutonomyCheckpoint {
  private readonly cpManager: CheckpointManager | null;
  private readonly dataDir: string;
  private readonly namespace: string;
  private readonly fileLockEnabled: boolean;
  private migrated = false;

  constructor(
    dataDir: string,
    namespace = "memory_autonomy_state",
    fileLockEnabled = true,
  ) {
    this.dataDir = dataDir;
    this.namespace = namespace;
    this.fileLockEnabled = fileLockEnabled;
    this.cpManager = fileLockEnabled ? new CheckpointManager(dataDir) : null;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Get the autonomy state for a session. Returns defaults for unknown sessions.
   * Performs one-time migration from PipelineSessionState if the autonomy
   * namespace is missing from the checkpoint file.
   */
  async getState(sessionKey: string): Promise<MemoryCheckpointState> {
    const cp = await this.readRaw();

    if (!cp[this.namespace] && !this.migrated) {
      await this.migrateFromPipelineState(cp);
      this.migrated = true;
      const cp2 = await this.readRaw();
      return this.extractState(cp2, sessionKey);
    }

    return this.extractState(cp, sessionKey);
  }

  /**
   * Atomically update the autonomy state for a single session.
   * Patches only the provided fields; unspecified fields keep their current values.
   */
  async updateState(
    sessionKey: string,
    patch: Partial<MemoryCheckpointState>,
  ): Promise<void> {
    await this.mutate((cp) => {
      if (!cp[this.namespace]) cp[this.namespace] = {};
      const current = this.mergeDefaults(cp[this.namespace][sessionKey]);
      cp[this.namespace][sessionKey] = { ...current, ...patch };
    });
  }

  /**
   * Atomically update state for multiple sessions in a single write.
   */
  async updateStates(
    patches: Record<string, Partial<MemoryCheckpointState>>,
  ): Promise<void> {
    await this.mutate((cp) => {
      if (!cp[this.namespace]) cp[this.namespace] = {};
      for (const [sessionKey, patch] of Object.entries(patches)) {
        const current = this.mergeDefaults(cp[this.namespace][sessionKey]);
        cp[this.namespace][sessionKey] = { ...current, ...patch };
      }
    });
  }

  /**
   * Get all session autonomy states (for scheduler iteration).
   */
  async getAllStates(): Promise<Record<string, MemoryCheckpointState>> {
    const cp = await this.readRaw();
    const autonomy = cp[this.namespace] ?? {};
    const result: Record<string, MemoryCheckpointState> = {};
    for (const [key, val] of Object.entries(autonomy)) {
      result[key] = this.mergeDefaults(val);
    }
    return result;
  }

  // ── Internal I/O ───────────────────────────────────────────────────────

  private async readRaw(): Promise<any> {
    if (this.cpManager) {
      return this.cpManager.read();
    }
    // Fallback: direct file read without lock
    const checkpointPath = this.checkpointFilePath();
    try {
      return JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    } catch {
      return {};
    }
  }

  private async writeRaw(cp: any): Promise<void> {
    if (this.cpManager) {
      await this.cpManager.write(cp);
      return;
    }
    // Fallback: direct file write without lock
    const checkpointPath = this.checkpointFilePath();
    const dir = path.dirname(checkpointPath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${checkpointPath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(cp, null, 2), "utf-8");
    await fs.rename(tmp, checkpointPath);
  }

  // TODO: wrap the full RMW cycle with CheckpointManager file lock.
  // Currently, two concurrent updateState() calls for different sessions
  // can overwrite each other if both readRaw() before either writeRaw().
  // The file lock should be acquired before readRaw() and released after
  // writeRaw() so the sequence is atomic across concurrent callers.
  private async mutate(fn: (cp: any) => void): Promise<void> {
    const cp = await this.readRaw();
    fn(cp);
    await this.writeRaw(cp);
  }

  private checkpointFilePath(): string {
    return path.join(this.dataDir, ".metadata", "recall_checkpoint.json");
  }

  // ── State helpers ──────────────────────────────────────────────────────

  private extractState(cp: any, sessionKey: string): MemoryCheckpointState {
    const autonomy = cp[this.namespace] ?? {};
    return this.mergeDefaults(autonomy[sessionKey]);
  }

  private mergeDefaults(raw: any): MemoryCheckpointState {
    const base = { ...DEFAULT_AUTONOMY_STATE };
    if (!raw || typeof raw !== "object") return base;
    return { ...base, ...raw };
  }

  // ── Migration ──────────────────────────────────────────────────────────

  /**
   * One-time migration from PipelineSessionState (pre-autonomy checkpoints).
   * Maps l2_pending_l1_count as `lastMemorySeqExtracted` (it represents the
   * difference counter, not absolute total — so pending work triggers correctly).
   * If the file already has memory_autonomy_state, migration is skipped.
   */
  private async migrateFromPipelineState(cp: any): Promise<void> {
    const pipelineStates = cp.pipeline_states ?? {};
    const autonomyState: Record<string, any> = {};

    for (const [sessionKey, ps] of Object.entries(pipelineStates) as [string, any][]) {
      const pendingCount = ps.l2_pending_l1_count ?? 0;
      const lastExtraction = ps.last_extraction_time
        ? new Date(ps.last_extraction_time).toISOString()
        : null;
      const l2LastExtraction = ps.l2_last_extraction_time
        ? new Date(ps.l2_last_extraction_time).toISOString()
        : null;
      const lastActive = ps.last_active_time
        ? new Date(ps.last_active_time).toISOString()
        : new Date(0).toISOString();

      autonomyState[sessionKey] = {
        lastMemorySeqExtracted: pendingCount,
        lastMemorySeqProcessedByL2: 0,
        lastSceneSeqExtracted: 0,
        lastSceneSeqProcessedByPersona: 0,
        lastL1CompletedAt: lastExtraction,
        lastL2CompletedAt: l2LastExtraction,
        lastPersonaAt: null,
        lastMeaningfulMemoryAt: null,
        sceneIndexUpdatedAt: null,
        l2JobStatus: "idle",
        personaJobStatus: "idle",
        sessionLastActiveAt: lastActive,
        sessionIsCold: false,
      };
    }

    cp[this.namespace] = autonomyState;
    await this.writeRaw(cp);
  }
}
