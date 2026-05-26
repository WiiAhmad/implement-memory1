// ═══════════════════════════════════════════════════════════════════════
//  [Step 44]  COORDINATION SERVICE — Cross-System Signal Bridge (Phase 5)
//  ═══════════════════════════════════════════════════════════════════════
//  Enables TDAI memory and offload to benefit from each other without
//  mixing responsibilities:
//
//  1. MMD → Scene resolution: When an offload MMD is fully completed,
//     the matching scene is marked as "resolved".
//  2. Scene → MMD naming: Active scene titles inform L1.5/L2 MMD labels.
//  3. Context injection: Persona/scene context is injected into messages
//     BEFORE offload L3 compression, so it is preserved in compressed output.
//
//  Spec reference: Section 7, 11 (Phase 5)
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { TencentMemoryAdapter } from "../memory/tencent-memory-adapter.ts";

// ─── Types ─────────────────────────────────────────────────────────────

export interface CoordinationMetrics {
  resolvedScenesFromMmd: number;
  mmdNamesFromScenes: number;
  contextInjections: number;
}

export interface ActiveSceneContext {
  sceneTitle: string | null;
  personaExists: boolean;
}

// ─── Class ─────────────────────────────────────────────────────────────

export class CoordinationService {
  private resolvedScenesFromMmd = 0;
  private mmdNamesFromScenes = 0;
  private contextInjections = 0;

  constructor(
    private readonly memory: TencentMemoryAdapter,
    private readonly logger?: Logger,
  ) {}

  // ─── Task 1: MMD → Scene Resolution ────────────────────────────────
  /**
   * Called when an offload MMD is fully completed (all nodes "done").
   * Finds matching scenes by title and marks them as "resolved".
   * Logs: [coordination] scene resolved mmd=<label> scene=<title>
   */
  async onMmdCompleted(sessionKey: string, mmdLabel: string): Promise<void> {
    if (!mmdLabel) return;

    try {
      const changed = await this.memory.resolveSceneByTitle(mmdLabel);
      if (changed) {
        this.resolvedScenesFromMmd++;
        this.logger?.info(`[coordination] scene resolved mmd="${mmdLabel}" session=${sessionKey}`);
      } else {
        this.logger?.debug(`[coordination] no matching active scene for completed MMD "${mmdLabel}" session=${sessionKey}`);
      }
    } catch (err) {
      this.logger?.warn(`[coordination] onMmdCompleted failed: ${err}`);
    }
  }

  // ─── Task 2: Scene → MMD Naming ────────────────────────────────────
  /**
   * Get active scene context for MMD naming hints.
   * Returns the title of the most important active scene, or null.
   */
  async getActiveSceneContext(sessionKey: string): Promise<ActiveSceneContext> {
    try {
      const sceneTitle = await this.memory.getTopActiveSceneTitle(sessionKey);
      return { sceneTitle, personaExists: !!sceneTitle };
    } catch {
      return { sceneTitle: null, personaExists: false };
    }
  }

  /**
   * Enrich L1.5 recent messages with scene context for better MMD naming.
   * If an active scene exists, prepend a hint so the L1.5 judge can use
   * it for MMD label selection.
   */
  async enrichL15Context(sessionKey: string, recentMessages: string): Promise<string> {
    const ctx = await this.getActiveSceneContext(sessionKey);
    if (!ctx.sceneTitle) return recentMessages;

    this.mmdNamesFromScenes++;
    this.logger?.info(`[coordination] mmd named scene="${ctx.sceneTitle}" session=${sessionKey}`);
    return `[Active Scene: ${ctx.sceneTitle}]\n${recentMessages}`;
  }

  // ─── Task 3: Context Injection Before Compression ──────────────────
  /**
   * Build a context injection string from memory recall output.
   * This content is injected into the messages array BEFORE offload
   * L3 compression, so the compressor preserves it rather than discarding it.
   */
  buildInjectionContext(recall: { prependContext?: string; appendSystemContext?: string }): string {
    const parts: string[] = [];

    if (recall.prependContext) {
      parts.push(recall.prependContext);
    }

    if (recall.appendSystemContext) {
      parts.push(recall.appendSystemContext);
    }

    return parts.length > 0 ? parts.join("\n\n") : "";
  }

  /**
   * Record a context injection event (called from context-agent.ts).
   */
  recordContextInjection(): void {
    this.contextInjections++;
  }

  // ─── Metrics ──────────────────────────────────────────────────────
  getMetrics(): CoordinationMetrics {
    return {
      resolvedScenesFromMmd: this.resolvedScenesFromMmd,
      mmdNamesFromScenes: this.mmdNamesFromScenes,
      contextInjections: this.contextInjections,
    };
  }
}
