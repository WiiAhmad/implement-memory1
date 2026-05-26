// ═══════════════════════════════════════════════════════════════════════
//  [Step 40]  SCENE INJECTION POLICY — Scene Selection & Injection Budget Logic
//  ═══════════════════════════════════════════════════════════════════════
//  Selects which scenes to include in the LLM context based on status,
//  importance score, token budget, and relevance to the current query.
//  Controls the active/stale/archive injection policy.
//
//  Spec reference: Section 5.3, Phase 3b
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";

export type SceneStatus = "active" | "stale" | "resolved" | "archived";

export interface SceneIndexEntry {
  filename: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
  status?: SceneStatus;
  importanceScore?: number;
  topicHash?: string;
  memoryCount?: number;
}

export interface InjectedScene {
  filename: string;
  title: string;
  summary: string;
  status: SceneStatus;
  importanceScore: number;
  /** Approximate tokens consumed by this scene navigation entry. */
  tokenCount: number;
}

export interface SceneInjectionConfig {
  maxActive: number;
  staleAfterDays: number;
  archiveAfterDays: number;
  maxTokenBudget: number;
}

export interface InjectionResult {
  scenes: InjectedScene[];
  totalTokens: number;
  activeCount: number;
  staleCount: number;
  archivedIncluded: number;
}

/**
 * Compute a simple token estimate (approx 4 chars per token for English text).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format a scene as a navigation entry for injection into the prompt.
 */
function formatSceneNav(scene: InjectedScene): string {
  return `- ${scene.title}: ${scene.summary}`;
}

export class SceneInjectionPolicy {
  constructor(
    private readonly dataDir: string,
    private readonly config: SceneInjectionConfig,
  ) {}

  /**
   * Select scenes for injection into the LLM context.
   *
   * 1. Read scene index
   * 2. Separate by status (active, stale, archived)
   * 3. Sort active by importance, take top maxActive
   * 4. Include stale scenes only if relevant keywords match query
   * 5. Exclude archived from default injection (included only if explicitly recalled)
   * 6. Respect token budget
   */
  async selectScenesForInjection(
    query?: string,
  ): Promise<InjectionResult> {
    const index = await this.readSceneIndex();
    const now = Date.now();

    // Separate by status
    const active: SceneIndexEntry[] = [];
    const stale: SceneIndexEntry[] = [];
    const archived: SceneIndexEntry[] = [];

    for (const entry of index) {
      const status = entry.status ?? "active";
      if (status === "active") active.push(entry);
      else if (status === "stale") stale.push(entry);
      else if (status === "archived") archived.push(entry);
    }

    // Sort active scenes by importance (descending), take top maxActive
    const sortedActive = active
      .sort((a, b) => (b.importanceScore ?? 0) - (a.importanceScore ?? 0))
      .slice(0, this.config.maxActive);

    // Build injected scene list from active
    const injected: InjectedScene[] = sortedActive.map((entry) => ({
      filename: entry.filename,
      title: entry.filename.replace(/\.md$/, ""),
      summary: entry.summary,
      status: "active",
      importanceScore: entry.importanceScore ?? 0,
      tokenCount: 0,
    }));

    // Add stale scenes only if relevant keywords match query
    if (query) {
      const queryLower = query.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter((t) => t.length > 2);

      for (const entry of stale) {
        const summaryLower = entry.summary.toLowerCase();
        const titleLower = entry.filename.replace(/\.md$/, "").toLowerCase();
        const isRelevant = queryTokens.some(
          (token) => summaryLower.includes(token) || titleLower.includes(token),
        );
        if (isRelevant) {
          injected.push({
            filename: entry.filename,
            title: entry.filename.replace(/\.md$/, ""),
            summary: entry.summary,
            status: "stale",
            importanceScore: entry.importanceScore ?? 0,
            tokenCount: 0,
          });
        }
      }
    }

    // Compute token counts and truncate to budget
    let totalTokens = 0;
    const scenesWithinBudget: InjectedScene[] = [];

    for (const scene of injected) {
      const navText = formatSceneNav(scene);
      const tokens = estimateTokens(navText);
      scene.tokenCount = tokens;

      if (totalTokens + tokens <= this.config.maxTokenBudget) {
        totalTokens += tokens;
        scenesWithinBudget.push(scene);
      } else {
        break;
      }
    }

    const activeCount = scenesWithinBudget.filter((s) => s.status === "active").length;
    const staleCount = scenesWithinBudget.filter((s) => s.status === "stale").length;
    const archivedIncluded = scenesWithinBudget.filter((s) => s.status === "archived").length;

    return {
      scenes: scenesWithinBudget,
      totalTokens,
      activeCount,
      staleCount,
      archivedIncluded,
    };
  }

  /**
   * Mark stale scenes and archive eligible scenes by updating the scene
   * block files' META sections. Returns counts of transitions applied.
   */
  async applyStaleAndArchiveTransitions(
    opts?: { archiveEnabled?: boolean },
  ): Promise<{
    markedStale: number;
    archived: number;
  }> {
    const index = await this.readSceneIndex();
    const archiveEnabled = opts?.archiveEnabled ?? true;
    const now = Date.now();
    const staleMs = this.config.staleAfterDays * 86_400_000;
    const archiveMs = this.config.archiveAfterDays * 86_400_000;

    let markedStale = 0;
    let archived = 0;

    for (const entry of index) {
      const updatedMs = entry.updated ? new Date(entry.updated).getTime() : 0;
      const ageMs = now - updatedMs;
      const currentStatus = entry.status ?? "active";

      try {
        const filePath = path.join(this.dataDir, "scene_blocks", entry.filename);
        const raw = await fs.readFile(filePath, "utf-8");

        let newStatus: SceneStatus | null = null;
        if (currentStatus === "active" && ageMs > staleMs) {
          newStatus = "stale";
          markedStale++;
        } else if (currentStatus === "stale" && ageMs > archiveMs && archiveEnabled) {
          newStatus = "archived";
          archived++;
        }

        if (newStatus) {
          // Update the META section status field
          const updated = raw.replace(
            /^status: .*/m,
            `status: ${newStatus}`,
          );
          if (updated !== raw) {
            await fs.writeFile(filePath, updated, "utf-8");
          } else {
            // Add status field if not present
            const withStatus = raw.replace(
              /^heat: .*/m,
              `heat: ${entry.heat}\nstatus: ${newStatus}`,
            );
            await fs.writeFile(filePath, withStatus, "utf-8");
          }
        }
      } catch {
        // Non-fatal — skip individual file errors
        continue;
      }
    }

    return { markedStale, archived };
  }

  /**
   * Format injected scenes as a compact navigation block for the prompt.
   */
  formatInjectionBlock(result: InjectionResult): string {
    if (result.scenes.length === 0) return "";

    const lines = ["## Scene Navigation", ""];
    for (const scene of result.scenes) {
      const statusTag = scene.status === "stale" ? " [stale]" : "";
      lines.push(`- ${scene.title}${statusTag}: ${scene.summary}`);
    }
    lines.push("");

    return lines.join("\n");
  }

  // ── Private helpers ───────────────────────────────────────────────────

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
