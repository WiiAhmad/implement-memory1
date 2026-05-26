import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneMetadataService } from "./scene-metadata.ts";

describe("SceneMetadataService", () => {
  test("getSceneIndex returns empty array when no index file", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-meta-"));
    try {
      const svc = new SceneMetadataService(tmpDir);
      const index = await svc.getSceneIndex();
      expect(index).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("getSceneIndex parses valid index file", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-meta-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "scene1.md", summary: "Test scene", heat: 5, created: "2025-01-01", updated: "2025-01-02", status: "active", importanceScore: 7.5, memoryCount: 3 },
          { filename: "scene2.md", summary: "Another scene", heat: 3, created: "2025-01-03", updated: "2025-01-04", status: "stale", importanceScore: 4.0, memoryCount: 1 },
        ]),
      );

      const svc = new SceneMetadataService(tmpDir);
      const index = await svc.getSceneIndex();
      expect(index).toHaveLength(2);
      expect(index[0]!.filename).toBe("scene1.md");
      expect(index[0]!.status).toBe("active");
      expect(index[1]!.status).toBe("stale");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("getSceneCounts returns counts by status", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-meta-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "a.md", summary: "A", heat: 1, created: "2025-01-01", updated: "2025-01-02", status: "active" },
          { filename: "b.md", summary: "B", heat: 1, created: "2025-01-01", updated: "2025-01-02", status: "active" },
          { filename: "c.md", summary: "C", heat: 1, created: "2025-01-01", updated: "2025-01-02", status: "stale" },
          { filename: "d.md", summary: "D", heat: 1, created: "2025-01-01", updated: "2025-01-02", status: "archived" },
          { filename: "e.md", summary: "E", heat: 1, created: "2025-01-01", updated: "2025-01-02", status: "resolved" },
        ]),
      );

      const svc = new SceneMetadataService(tmpDir);
      const counts = await svc.getSceneCounts();
      expect(counts.active).toBe(2);
      expect(counts.stale).toBe(1);
      expect(counts.archived).toBe(1);
      expect(counts.resolved).toBe(1);
      expect(counts.total).toBe(5);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("getStaleScenes returns scenes older than staleAfterDays", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-meta-"));
    try {
      const oldDate = new Date(Date.now() - 20 * 86_400_000).toISOString(); // 20 days ago
      const recentDate = new Date().toISOString();
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "old.md", summary: "Old", heat: 1, created: oldDate, updated: oldDate, status: "active" },
          { filename: "recent.md", summary: "Recent", heat: 1, created: recentDate, updated: recentDate, status: "active" },
        ]),
      );

      const svc = new SceneMetadataService(tmpDir);
      const stale = await svc.getStaleScenes(7); // 7 day threshold
      expect(stale).toEqual(["old.md"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("getArchivableScenes returns only stale scenes older than archiveAfterDays", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-meta-"));
    try {
      const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString(); // 40 days ago
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "archivable.md", summary: "Old stale", heat: 1, created: oldDate, updated: oldDate, status: "stale" },
          { filename: "active.md", summary: "Active", heat: 1, created: oldDate, updated: oldDate, status: "active" },
        ]),
      );

      const svc = new SceneMetadataService(tmpDir);
      const archivable = await svc.getArchivableScenes(30); // 30 day threshold
      expect(archivable).toEqual(["archivable.md"]); // only stale + old enough
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
