import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneDedupService } from "./scene-dedup.ts";

describe("SceneDedupService", () => {
  test("returns empty result when disabled", async () => {
    const svc = new SceneDedupService("/tmp", { mergeThreshold: 0.86, enabled: false });
    const result = await svc.batchDedup();
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  test("returns empty result with fewer than 2 scenes", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dedup-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "single.md", summary: "Only scene", heat: 3, created: "2025-01-01", updated: "2025-01-02" },
        ]),
      );

      const svc = new SceneDedupService(tmpDir, { mergeThreshold: 0.86, enabled: true });
      const result = await svc.batchDedup();
      expect(result.candidates).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("detects similar scenes by topic hash match", async () => {
    const svc = new SceneDedupService("/tmp", { mergeThreshold: 0.86, enabled: true });
    const similarity = svc.computeSimilarity(
      { filename: "a.md", summary: "Football and soccer", heat: 5, created: "", updated: "", topicHash: "football::soccer" },
      { filename: "b.md", summary: "Soccer game rules", heat: 3, created: "", updated: "", topicHash: "football::soccer" },
    );
    expect(similarity).toBe(1.0); // exact topic hash match
  });

  test("detects similar scenes by keyword overlap", async () => {
    const svc = new SceneDedupService("/tmp", { mergeThreshold: 0.86, enabled: true });
    const similarity = svc.computeSimilarity(
      { filename: "a.md", summary: "Football soccer game rules and training", heat: 5, created: "", updated: "", topicHash: "" },
      { filename: "b.md", summary: "Soccer game football training exercise", heat: 3, created: "", updated: "", topicHash: "" },
    );
    // Both have: football, soccer, game, training - 4 overlapping / 6 union = 0.67
    expect(similarity).toBeGreaterThan(0.5);
    expect(similarity).toBeLessThan(1.0);
  });

  test("returns low similarity for unrelated scenes", async () => {
    const svc = new SceneDedupService("/tmp", { mergeThreshold: 0.86, enabled: true });
    const similarity = svc.computeSimilarity(
      { filename: "a.md", summary: "Football soccer game", heat: 5, created: "", updated: "", topicHash: "" },
      { filename: "b.md", summary: "Cooking recipes kitchen", heat: 3, created: "", updated: "", topicHash: "" },
    );
    expect(similarity).toBe(0);
  });

  test("batchDedup returns candidates with similarity above threshold", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dedup-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "sports.md", summary: "Football soccer game rules training", heat: 5, created: "2025-01-01", updated: "2025-01-02", topicHash: "" },
          { filename: "cooking.md", summary: "Cooking recipes kitchen", heat: 3, created: "2025-01-01", updated: "2025-01-02", topicHash: "" },
          { filename: "athletics.md", summary: "Soccer football training exercise game", heat: 4, created: "2025-01-01", updated: "2025-01-02", topicHash: "" },
        ]),
      );

      const svc = new SceneDedupService(tmpDir, { mergeThreshold: 0.3, enabled: true }); // low threshold for testing
      const result = await svc.batchDedup();
      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
      // Should find sports.md related to athletics.md
      const sportsAthletics = result.candidates.find(
        (c) => (c.source === "sports.md" && c.target === "athletics.md") || (c.source === "athletics.md" && c.target === "sports.md"),
      );
      expect(sportsAthletics).toBeDefined();
      expect(sportsAthletics!.similarity).toBeGreaterThan(0.3);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("batchDedup returns empty when no index file", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dedup-"));
    try {
      const svc = new SceneDedupService(tmpDir, { mergeThreshold: 0.86, enabled: true });
      const result = await svc.batchDedup();
      expect(result.candidates).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
