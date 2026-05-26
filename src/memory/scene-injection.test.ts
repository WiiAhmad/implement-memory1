import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneInjectionPolicy, type SceneInjectionConfig } from "./scene-injection.ts";

function makeConfig(overrides?: Partial<SceneInjectionConfig>): SceneInjectionConfig {
  return {
    maxActive: 30,
    staleAfterDays: 7,
    archiveAfterDays: 21,
    maxTokenBudget: 2000,
    ...overrides,
  };
}

describe("SceneInjectionPolicy", () => {
  test("returns empty result when no scenes exist", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-inj-"));
    try {
      const policy = new SceneInjectionPolicy(tmpDir, makeConfig());
      const result = await policy.selectScenesForInjection();
      expect(result.scenes).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("picks active scenes up to maxActive, sorted by importance", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-inj-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      const scenes = Array.from({ length: 5 }, (_, i) => ({
        filename: `scene${i + 1}.md`,
        summary: `Test scene ${i + 1}`,
        heat: i * 2,
        created: "2025-01-01",
        updated: "2025-01-02",
        status: "active" as const,
        importanceScore: (i + 1) * 2,
        memoryCount: i + 1,
      }));
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify(scenes),
      );

      const policy = new SceneInjectionPolicy(tmpDir, makeConfig({ maxActive: 3 }));
      const result = await policy.selectScenesForInjection();
      expect(result.scenes).toHaveLength(3);
      expect(result.activeCount).toBe(3);
      // Should have the highest importance scores
      expect(result.scenes[0]!.importanceScore).toBe(10); // scene5 (i=4, score=10)
      expect(result.scenes[2]!.importanceScore).toBe(6);  // scene3 (i=2, score=6)
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("excludes archived scenes from default injection", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-inj-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "active.md", summary: "Active scene", heat: 5, created: "2025-01-01", updated: "2025-01-02", status: "active", importanceScore: 8 },
          { filename: "archived.md", summary: "Archived scene", heat: 1, created: "2025-01-01", updated: "2025-01-02", status: "archived", importanceScore: 2 },
        ]),
      );

      const policy = new SceneInjectionPolicy(tmpDir, makeConfig());
      const result = await policy.selectScenesForInjection();
      expect(result.scenes).toHaveLength(1);
      expect(result.scenes[0]!.filename).toBe("active.md");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("includes stale scenes only when relevant keywords match query", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-inj-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify([
          { filename: "sports.md", summary: "Football and soccer discussions", heat: 3, created: "2025-01-01", updated: "2025-01-02", status: "stale", importanceScore: 4 },
          { filename: "cooking.md", summary: "Recipes and kitchen tips", heat: 3, created: "2025-01-01", updated: "2025-01-02", status: "stale", importanceScore: 4 },
        ]),
      );

      const policy = new SceneInjectionPolicy(tmpDir, makeConfig());
      const result = await policy.selectScenesForInjection("football");
      expect(result.scenes).toHaveLength(1);
      expect(result.scenes[0]!.filename).toBe("sports.md");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("respects token budget for scene navigation", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scene-inj-"));
    try {
      const metaDir = path.join(tmpDir, ".metadata");
      await mkdir(metaDir, { recursive: true });
      const scenes = Array.from({ length: 20 }, (_, i) => ({
        filename: `scene${i + 1}.md`,
        summary: `Scene number ${i + 1} with a fairly long description to take up tokens`,
        heat: i,
        created: "2025-01-01",
        updated: "2025-01-02",
        status: "active" as const,
        importanceScore: 20 - i,
        memoryCount: 1,
      }));
      await writeFile(
        path.join(metaDir, "scene_index.json"),
        JSON.stringify(scenes),
      );

      const policy = new SceneInjectionPolicy(tmpDir, makeConfig({ maxTokenBudget: 200, maxActive: 20 }));
      const result = await policy.selectScenesForInjection();
      // Should fit within budget
      expect(result.totalTokens).toBeLessThanOrEqual(200);
      // Should have some scenes but not all 20
      expect(result.scenes.length).toBeGreaterThan(0);
      expect(result.scenes.length).toBeLessThan(20);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
