// ═══════════════════════════════════════════════════════════════════════
//  [Step 18]  TENCENT MEMORY ADAPTER — TDAI Engine Wrapper
//  ═══════════════════════════════════════════════════════════════════════
//  Concrete implementation of MemoryAdapter backed by the
//  TencentDB-Agent-Memory engine (TDAI). Handles:
//  - Initialization (StandaloneHostAdapter + TdaiCore)
//  - Memory recall before each LLM turn
//  - Memory capture after each LLM turn
//  - Graceful shutdown via core.destroy()
// ═══════════════════════════════════════════════════════════════════════

import { StandaloneHostAdapter } from "../../TencentDB-Agent-Memory/src/adapters/standalone/host-adapter.ts";
import { parseConfig } from "../../TencentDB-Agent-Memory/src/config.ts";
import { TdaiCore } from "../../TencentDB-Agent-Memory/src/core/tdai-core.ts";
import type { CompletedTurn, Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { AppEnv } from "../config/env.ts";
import type { AppPaths } from "../utils/paths.ts";
import { buildTdaiRawConfig } from "./build-memory-config.ts";
import type { MemoryAdapter, MemoryRecall } from "./types.ts";
import { SceneInjectionPolicy, type SceneInjectionConfig } from "./scene-injection.ts";
import { SceneMetadataService } from "./scene-metadata.ts";
import { SceneDedupService, type SceneDedupConfig } from "./scene-dedup.ts";

/**
 * Pipeline log prefixes for consistent log format.
 * Used in L2/L3 decision logging per spec Section 9.
 */
const PREFIX = "[memory-tdai]";

export class TencentMemoryAdapter implements MemoryAdapter {
  public readonly dataDir: string;
  public readonly sceneMetadata: SceneMetadataService;
  public readonly sceneInjection: SceneInjectionPolicy;
  public readonly sceneDedup: SceneDedupService;

  private readonly archiveEnabled: boolean;

  constructor(
    private readonly core: TdaiCore,
    private readonly logger?: Logger,
    opts?: {
      injectionConfig?: SceneInjectionConfig;
      dedupConfig?: SceneDedupConfig;
      dataDir: string;
      archiveEnabled?: boolean;
    },
  ) {
    this.dataDir = opts?.dataDir ?? "";
    this.archiveEnabled = opts?.archiveEnabled ?? false;
    this.sceneMetadata = new SceneMetadataService(this.dataDir);
    this.sceneInjection = new SceneInjectionPolicy(
      this.dataDir,
      opts?.injectionConfig ?? {
        maxActive: 30,
        staleAfterDays: 7,
        archiveAfterDays: 21,
        maxTokenBudget: 2000,
      },
    );
    this.sceneDedup = new SceneDedupService(
      this.dataDir,
      opts?.dedupConfig ?? { mergeThreshold: 0.86, enabled: false },
    );
  }

  // ─── Step 18a: Factory — create TDAI engine and wire dependencies ─────
  //  1. Create StandaloneHostAdapter (standalone mode, no OpenClaw plugin)
  //  2. Parse full config from environment variables
  //  3. Initialize TdaiCore (L0 recorder, L1 extractor, persona, scenes, etc.)
  static async create(env: AppEnv, paths: AppPaths, logger: Logger): Promise<TencentMemoryAdapter> {
    const hostAdapter = new StandaloneHostAdapter({
      dataDir: paths.memoryDir,
      llmConfig: {
        baseUrl: env.baseUrl,
        apiKey: env.openAIApiKey,
        model: env.model,
        maxTokens: 4096,
        timeoutMs: 120000,
      },
      logger,
      defaultUserId: "telegram-user",
      platform: "telegram",
    });

    const config = parseConfig(buildTdaiRawConfig(env));
    const core = new TdaiCore({ hostAdapter, config });
    await core.initialize();
    return new TencentMemoryAdapter(core, logger, {
      dataDir: paths.memoryDir,
      injectionConfig: {
        maxActive: env.memory.personaMaxScenes,
        staleAfterDays: env.autonomy.sceneStaleAfterDays,
        archiveAfterDays: env.autonomy.sceneArchiveAfterDays,
        maxTokenBudget: 2000,
      },
      dedupConfig: {
        mergeThreshold: env.autonomy.sceneMergeThreshold,
        enabled: env.autonomy.featureGates.sceneMerge,
      },
      archiveEnabled: env.autonomy.featureGates.sceneArchive,
    });
  }

  // ─── Step 18b: Recall memories before an LLM turn ───────────────────
  //  Delegates to TdaiCore.handleBeforeRecall() which runs:
  //  - BM25 keyword search for relevant memories
  //  - Persona/scene context assembly
  async recall(userKey: string, query: string): Promise<MemoryRecall> {
    const result = await this.core.handleBeforeRecall(query, userKey);

    // Apply scene injection policy: select active scenes by importance,
    // include stale only if relevant, exclude archived unless recalled.
    let injectionBlock = "";
    let injectionSceneCount = 0;
    try {
      const injectionResult = await this.sceneInjection.selectScenesForInjection(query);
      injectionSceneCount = injectionResult.scenes.length;
      if (injectionResult.scenes.length > 0) {
        injectionBlock = this.sceneInjection.formatInjectionBlock(injectionResult);
      }
    } catch (err) {
      this.logger?.warn(`${PREFIX} [recall] scene injection failed: ${err}`);
    }

    // Merge injection block into prependContext (scene navigation goes first)
    const prependContext = injectionBlock
      ? injectionBlock + "\n" + (result.prependContext ?? "")
      : (result.prependContext ?? "");

    const hasPersona = !!result.appendSystemContext?.includes("persona");
    const sceneCount = (result.prependContext ?? "").split("Scene:").length - 1;

    if (this.logger) {
      this.logger.info(
        `${PREFIX} [recall] session=${userKey} persona=${hasPersona} scenes=${sceneCount} injection_scenes=${injectionSceneCount} context_len=${prependContext.length + (result.appendSystemContext ?? "").length}`,
      );
    }

    return {
      prependContext,
      appendSystemContext: result.appendSystemContext,
    };
  }

  // ─── Step 18c: Capture a completed turn into memory ─────────────────
  //  Builds a CompletedTurn object with user + assistant messages and
  //  delegates to TdaiCore.handleTurnCommitted() which triggers:
  //  - L0 recording (raw dialogue)
  //  - L1 extraction (structured memories)
  //  - L2 scene extraction
  //  - L3 persona updates
  //  Logs the outcome at each layer for observability (spec Section 9).
  async capture(userKey: string, userText: string, assistantText: string): Promise<void> {
    const startedAt = Date.now();
    const turn: CompletedTurn = {
      userText,
      assistantText,
      sessionKey: userKey,
      startedAt,
      messages: [
        {
          id: `user-${startedAt}`,
          role: "user",
          content: userText,
          timestamp: startedAt,
        },
        {
          id: `assistant-${startedAt + 1}`,
          role: "assistant",
          content: assistantText,
          timestamp: startedAt + 1,
        },
      ],
    };

    const l0StartedAt = Date.now();
    await this.core.handleTurnCommitted(turn);
    const duration = Date.now() - l0StartedAt;

    // Log pipeline outcome after capture completes.
    // The TDAI core internally runs L1 extraction, L2 scene extraction,
    // and L3 persona generation based on its own trigger logic.
    // We capture the observable outcome here.
    if (this.logger) {
      this.logger.info(
        `${PREFIX} [capture] session=${userKey} duration=${duration}ms L0_recorded=true`,
      );
      this.logger.info(
        `${PREFIX} [pipeline] L1 scheduled reason=after_turn session=${userKey}`,
      );
    }
  }

  /** Expose the underlying TdaiCore for tool execution and advanced access. */
  getCore(): TdaiCore {
    return this.core;
  }

  // ─── MemoryPipeline interface (for Scheduler) ─────────────────────────
  //  Phase 2 stub implementations. These delegate to the TDAI engine internals
  //  and are only called in "active" scheduler phase (default is "observer").

  /**
   * Run L2 scene extraction for a session.
   * Delegates to the TDAI core's internal L2 pipeline via its commit flow.
   */
  async runL2(sessionKey: string): Promise<void> {
    if (this.logger) {
      this.logger.info(`${PREFIX} [pipeline] L2 dispatch session=${sessionKey}`);
    }
    // The TDAI engine handles L2 internally via handleTurnCommitted().
    // For explicit L2 trigger, we rely on the engine's internal scheduling.
    // This is a placeholder for Phase 3+ active scheduling.
  }

  /**
   * Apply scene maintenance: stale/archive transitions and dedup.
   * Called by the Scheduler after L2 completion.
   */
  async runSceneMaintenance(sessionKey: string): Promise<{
    staleTransitions: number;
    archiveTransitions: number;
    dedupCandidates: number;
  }> {
    const maintenanceResult = { staleTransitions: 0, archiveTransitions: 0, dedupCandidates: 0 };

    try {
      const transitionResult = await this.sceneInjection.applyStaleAndArchiveTransitions({
        archiveEnabled: this.archiveEnabled,
      });
      maintenanceResult.staleTransitions = transitionResult.markedStale;
      maintenanceResult.archiveTransitions = transitionResult.archived;

      if (this.logger && (transitionResult.markedStale > 0 || transitionResult.archived > 0)) {
        this.logger.info(
          `${PREFIX} [maintenance] scene_transitions session=${sessionKey} stale=${transitionResult.markedStale} archived=${transitionResult.archived}`,
        );
      }
    } catch (err) {
      this.logger?.error(`${PREFIX} [maintenance] stale/archive transition failed: ${err}`);
    }

    try {
      const dedupResult = await this.sceneDedup.batchDedup();
      maintenanceResult.dedupCandidates = dedupResult.candidates.length;

      if (this.logger && dedupResult.candidates.length > 0) {
        this.logger.info(
          `${PREFIX} [maintenance] dedup session=${sessionKey} candidates=${dedupResult.candidates.length}`,
        );
        for (const c of dedupResult.candidates) {
          this.logger.info(
            `${PREFIX} [maintenance] dedup_candidate source=${c.source} target=${c.target} similarity=${c.similarity.toFixed(3)}`,
          );
        }
      }
    } catch (err) {
      this.logger?.error(`${PREFIX} [maintenance] dedup failed: ${err}`);
    }

    return maintenanceResult;
  }

  /**
   * Run L3 persona generation for a session.
   * Delegates to the TDAI core's internal persona pipeline.
   */
  async runPersona(sessionKey: string): Promise<void> {
    if (this.logger) {
      this.logger.info(`${PREFIX} [pipeline] persona dispatch session=${sessionKey}`);
    }
    // Placeholder for Phase 3+ active persona scheduling.
  }

  /**
   * Get the current scene count for a session.
   */
  async getSceneCount(sessionKey: string): Promise<number> {
    try {
      const sceneIndex = await this.core.sceneIndex;
      if (sceneIndex) {
        return sceneIndex.scenes?.length ?? 0;
      }
    } catch {
      // Scene index not available yet
    }
    return 0;
  }

  // ─── Step 18d: Scene resolution for cross-system coordination ─────
  /**
   * Get the title of the top (most important) active scene.
   * Used by CoordinationService to inform MMD naming.
   */
  async getTopActiveSceneTitle(sessionKey: string): Promise<string | null> {
    try {
      const index = await this.sceneMetadata.getSceneIndex();
      const activeScenes = index
        .filter((e) => (e.status ?? "active") === "active")
        .sort((a, b) => (b.importanceScore ?? 0) - (a.importanceScore ?? 0));
      if (activeScenes.length === 0) return null;
      return activeScenes[0]!.filename.replace(/\.md$/, "");
    } catch {
      return null;
    }
  }

  /**
   * Mark a scene as resolved by title match.
   * Used by CoordinationService when a corresponding MMD completes.
   */
  async resolveSceneByTitle(title: string): Promise<boolean> {
    try {
      const index = await this.sceneMetadata.getSceneIndex();
      const normalizedTitle = title.toLowerCase().replace(/[_-]/g, " ").trim();

      for (const entry of index) {
        const sceneTitle = entry.filename.replace(/\.md$/, "").toLowerCase().replace(/[_-]/g, " ").trim();
        const isMatch = sceneTitle.includes(normalizedTitle) || normalizedTitle.includes(sceneTitle);
        if (isMatch && (entry.status ?? "active") === "active") {
          const changed = await this.sceneMetadata.markSceneResolved(entry.filename);
          return changed;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ─── Step 18e: Graceful shutdown ────────────────────────────────────
  async close(): Promise<void> {
    await this.core.destroy();
  }
}
