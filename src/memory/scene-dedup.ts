// ═══════════════════════════════════════════════════════════════════════
//  [Step 39]  SCENE DEDUP SERVICE — Root-Side Dedup Orchestrator
//  ═══════════════════════════════════════════════════════════════════════
//  Reads scene metadata from the TDAI scene index, compares scenes for
//  similarity using topic hash and keyword overlap, and reports merge
//  candidates. Actual merge logic lives in the TDAI vendor code; this
//  service provides the root-side orchestration and logging.
//
//  Spec reference: Section 5.3, Phase 3c
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";

export interface SceneDedupConfig {
  mergeThreshold: number;
  enabled: boolean;
}

export interface DedupResult {
  merged: number;
  skipped: number;
  errors: string[];
  candidates: Array<{
    source: string;
    target: string;
    similarity: number;
  }>;
}

export interface SceneIndexEntry {
  filename: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
  status?: string;
  importanceScore?: number;
  topicHash?: string;
  memoryCount?: number;
}

export class SceneDedupService {
  constructor(
    private readonly dataDir: string,
    private readonly config: SceneDedupConfig,
  ) {}

  /**
   * Run batch dedup on all scenes for a session.
   * Compares each pair of scenes for similarity using topic hash and
   * keyword overlap. Returns merge candidates for the caller to process.
   */
  async batchDedup(): Promise<DedupResult> {
    if (!this.config.enabled) {
      return { merged: 0, skipped: 0, errors: [], candidates: [] };
    }

    const index = await this.readSceneIndex();
    if (index.length < 2) {
      return { merged: 0, skipped: 0, errors: [], candidates: [] };
    }

    const errors: string[] = [];
    const candidates: DedupResult["candidates"] = [];
    const mergedFilenames = new Set<string>();

    // Compare each pair
    for (let i = 0; i < index.length; i++) {
      for (let j = i + 1; j < index.length; j++) {
        const a = index[i]!;
        const b = index[j]!;

        // Skip if either has already been merged
        if (mergedFilenames.has(a.filename) || mergedFilenames.has(b.filename)) continue;

        try {
          const similarity = this.computeSimilarity(a, b);
          if (similarity >= this.config.mergeThreshold) {
            candidates.push({
              source: a.filename,
              target: b.filename,
              similarity,
            });
          }
        } catch (err) {
          errors.push(`pair ${a.filename}/${b.filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return {
      merged: 0, // Actual merge happens in TDAI vendor code
      skipped: index.length - candidates.length * 2,
      errors,
      candidates,
    };
  }

  /**
   * Compute similarity between two scenes (0.0–1.0).
   * Uses topic hash exact match + keyword overlap.
   */
  computeSimilarity(a: SceneIndexEntry, b: SceneIndexEntry): number {
    // Topic hash exact match = high similarity
    if (a.topicHash && b.topicHash && a.topicHash === b.topicHash) {
      return 1.0;
    }

    // Keyword overlap between summaries
    const tokensA = this.tokenize(a.summary);
    const tokensB = this.tokenize(b.summary);

    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const intersection = tokensA.filter((t) => tokensB.includes(t));
    const union = [...new Set([...tokensA, ...tokensB])];

    return intersection.length / union.length;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  private async readSceneIndex(): Promise<SceneIndexEntry[]> {
    const indexPath = path.join(this.dataDir, ".metadata", "scene_index.json");
    try {
      const raw = await fs.readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as SceneIndexEntry[];
    } catch {
      return [];
    }
  }
}
