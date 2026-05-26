// ═══════════════════════════════════════════════════════════════════════
//  [Step 41]  SCENE METADATA SERVICE — Root-Side Scene Metadata Reader/Aggregator
//  ═══════════════════════════════════════════════════════════════════════
//  Reads scene metadata from the TDAI scene index and provides
//  convenience methods for counting by status, detecting stale scenes,
//  and computing importance. All state comes from the scene index and
//  scene block files on disk — no vendor edits needed beyond Phase 3a.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";

/** Status transitions for scene lifecycle management. */
export type SceneStatus = "active" | "stale" | "resolved" | "archived";

/** Scene index entry read from the TDAI scene index. */
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

/** Aggregated scene counts by status. */
export interface SceneCounts {
  active: number;
  stale: number;
  archived: number;
  resolved: number;
  total: number;
}

/** Per-scene importance report. */
export interface SceneImportanceReport {
  entries: Array<{
    filename: string;
    title: string;
    importanceScore: number;
    status: SceneStatus;
    daysSinceUpdate: number;
  }>;
  averageImportance: number;
}

export class SceneMetadataService {
  constructor(private readonly dataDir: string) {}

  /**
   * Read the scene index from disk.
   */
  async getSceneIndex(): Promise<SceneIndexEntry[]> {
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

  /**
   * Get the full filesystem path to a scene block file.
   */
  getSceneBlockPath(filename: string): string {
    return path.join(this.dataDir, "scene_blocks", filename);
  }

  /**
   * Mark a scene as resolved by updating its status in the scene block file.
   * Returns true if the status was changed, false if already resolved or error.
   */
  async markSceneResolved(filename: string): Promise<boolean> {
    try {
      const filePath = this.getSceneBlockPath(filename);
      const raw = await fs.readFile(filePath, "utf-8");

      // Check current status — skip if already resolved or archived
      const statusMatch = raw.match(/^status: (.+)/m);
      if (statusMatch) {
        const currentStatus = statusMatch[1]!.trim();
        if (currentStatus === "resolved" || currentStatus === "archived") return false;
      }

      // Update status field if present, or add it after heat:
      const hasStatus = /^status: /m.test(raw);
      let updated: string;
      if (hasStatus) {
        updated = raw.replace(/^status: .*/m, "status: resolved");
      } else {
        updated = raw.replace(/^(heat: .*)/m, "$1\nstatus: resolved");
      }

      if (updated !== raw) {
        await fs.writeFile(filePath, updated, "utf-8");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get scene counts broken down by status.
   */
  async getSceneCounts(): Promise<SceneCounts> {
    const index = await this.getSceneIndex();
    const counts: SceneCounts = { active: 0, stale: 0, archived: 0, resolved: 0, total: index.length };

    for (const entry of index) {
      const status = entry.status ?? "active";
      if (status === "active") counts.active++;
      else if (status === "stale") counts.stale++;
      else if (status === "archived") counts.archived++;
      else if (status === "resolved") counts.resolved++;
    }

    return counts;
  }

  /**
   * Get stale scene filenames (updatedAt + staleAfterDays < now).
   */
  async getStaleScenes(staleAfterDays: number): Promise<string[]> {
    const index = await this.getSceneIndex();
    const now = Date.now();
    const staleMs = staleAfterDays * 86_400_000;

    return index
      .filter((entry) => {
        const updated = entry.updated ? new Date(entry.updated).getTime() : 0;
        return now - updated > staleMs;
      })
      .map((entry) => entry.filename);
  }

  /**
   * Get archivable scene filenames (stale + updatedAt + archiveAfterDays < now).
   */
  async getArchivableScenes(archiveAfterDays: number): Promise<string[]> {
    const index = await this.getSceneIndex();
    const now = Date.now();
    const archiveMs = archiveAfterDays * 86_400_000;

    return index
      .filter((entry) => {
        const status = entry.status ?? "active";
        if (status !== "stale") return false;
        const updated = entry.updated ? new Date(entry.updated).getTime() : 0;
        return now - updated > archiveMs;
      })
      .map((entry) => entry.filename);
  }

  /**
   * Compute an importance report across all scenes.
   */
  async getSceneImportance(): Promise<SceneImportanceReport> {
    const index = await this.getSceneIndex();
    const now = Date.now();

    const entries = index.map((entry) => {
      const updatedMs = entry.updated ? new Date(entry.updated).getTime() : now;
      const daysSinceUpdate = Math.max(0, (now - updatedMs) / 86_400_000);
      return {
        filename: entry.filename,
        title: entry.filename.replace(/\.md$/, ""),
        importanceScore: entry.importanceScore ?? 0,
        status: entry.status ?? "active",
        daysSinceUpdate,
      };
    });

    const averageImportance = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.importanceScore, 0) / entries.length
      : 0;

    return { entries, averageImportance };
  }
}
