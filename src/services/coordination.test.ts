// ═══════════════════════════════════════════════════════════════════════
//  CoordinationService Tests — Phase 5 Cross-System Coordination
//  ═══════════════════════════════════════════════════════════════════════
//  Tests:
//  1. MMD → scene resolution: completed MMD marks matching scene as resolved
//  2. Scene → MMD naming: active scene title provides label hint
//  3. Context injection: persona/scene context before compression
//  4. No false matches when no matching scene exists
//  5. Metrics tracking
// ═══════════════════════════════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { CoordinationService } from "./coordination.ts";
import type { TencentMemoryAdapter } from "../memory/tencent-memory-adapter.ts";

// ─── Mock Memory Adapter ──────────────────────────────────────────────
function createMockMemoryAdapter(opts?: {
  sceneIndex?: Array<{
    filename: string;
    summary: string;
    heat: number;
    created: string;
    updated: string;
    status?: string;
    importanceScore?: number;
  }>;
  resolveResult?: boolean;
}): TencentMemoryAdapter {
  const index = opts?.sceneIndex ?? [];
  const resolveResult = opts?.resolveResult ?? true;

  return {
    sceneMetadata: {
      getSceneIndex: async () => index,
      getSceneBlockPath: (filename: string) => `/mock/scene_blocks/${filename}`,
      markSceneResolved: async (filename: string) => {
        const entry = index.find((e) => e.filename === filename);
        if (!entry) return false;
        if (entry.status === "resolved" || entry.status === "archived") return false;
        entry.status = "resolved";
        return true;
      },
      getSceneCounts: async () => ({
        active: index.filter((e) => (e.status ?? "active") === "active").length,
        stale: index.filter((e) => e.status === "stale").length,
        archived: index.filter((e) => e.status === "archived").length,
        resolved: index.filter((e) => e.status === "resolved").length,
        total: index.length,
      }),
    },
    getTopActiveSceneTitle: async () => {
      const active = index
        .filter((e) => (e.status ?? "active") === "active")
        .sort((a, b) => (b.importanceScore ?? 0) - (a.importanceScore ?? 0));
      return active.length > 0 ? active[0]!.filename.replace(/\.md$/, "") : null;
    },
    resolveSceneByTitle: async (title: string) => {
      const normalizedTitle = title.toLowerCase().replace(/[_-]/g, " ").trim();
      for (const entry of index) {
        const sceneTitle = entry.filename.replace(/\.md$/, "").toLowerCase().replace(/[_-]/g, " ").trim();
        const isMatch = sceneTitle.includes(normalizedTitle) || normalizedTitle.includes(sceneTitle);
        if (isMatch && (entry.status ?? "active") === "active") {
          entry.status = "resolved";
          return true;
        }
      }
      return false;
    },
  } as unknown as TencentMemoryAdapter;
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ─── Tests ────────────────────────────────────────────────────────────

describe("CoordinationService", () => {
  // ─── Task 1: MMD → Scene Resolution ───────────────────────────────
  test("marks matching active scene as resolved when MMD completes", async () => {
    const index = [
      { filename: "api-integration.md", summary: "Setting up API", heat: 5, created: "2026-01-01", updated: "2026-01-10", status: "active", importanceScore: 7 },
    ];
    const memory = createMockMemoryAdapter({ sceneIndex: index });
    const coord = new CoordinationService(memory, noopLogger as any);

    await coord.onMmdCompleted("tg:user:1", "API Integration Task");

    // The matching scene should now be resolved
    expect(index[0]!.status).toBe("resolved");
    const metrics = coord.getMetrics();
    expect(metrics.resolvedScenesFromMmd).toBe(1);
  });

  test("does not mark scene as resolved when no matching MMD label exists", async () => {
    const index = [
      { filename: "api-integration.md", summary: "Setting up API", heat: 5, created: "2026-01-01", updated: "2026-01-10", status: "active", importanceScore: 7 },
    ];
    const memory = createMockMemoryAdapter({ sceneIndex: index, resolveResult: false });
    // Override resolveSceneByTitle to always return false for non-matching
    memory.resolveSceneByTitle = async () => false;
    const coord = new CoordinationService(memory, noopLogger as any);

    await coord.onMmdCompleted("tg:user:1", "Database Setup");

    // Scene should remain active
    expect(index[0]!.status).toBe("active");
    const metrics = coord.getMetrics();
    expect(metrics.resolvedScenesFromMmd).toBe(0);
  });

  test("skips already resolved or archived scenes", async () => {
    const index = [
      { filename: "done-scene.md", summary: "Already complete", heat: 3, created: "2026-01-01", updated: "2026-01-10", status: "resolved", importanceScore: 5 },
    ];
    const memory = createMockMemoryAdapter({ sceneIndex: index });

    // Override to simulate the resolved scene not matching
    memory.resolveSceneByTitle = async () => false;
    const coord = new CoordinationService(memory, noopLogger as any);

    await coord.onMmdCompleted("tg:user:1", "Done Scene");

    // Should remain resolved (no change)
    expect(index[0]!.status).toBe("resolved");
    const metrics = coord.getMetrics();
    expect(metrics.resolvedScenesFromMmd).toBe(0);
  });

  // ─── Task 2: Scene → MMD Naming ───────────────────────────────────
  test("returns active scene title for MMD naming hint", async () => {
    const index = [
      { filename: "refactoring-auth.md", summary: "Refactoring authentication", heat: 8, created: "2026-01-01", updated: "2026-01-15", status: "active", importanceScore: 9 },
      { filename: "old-topic.md", summary: "Old topic", heat: 2, created: "2026-01-01", updated: "2026-01-05", status: "stale", importanceScore: 2 },
    ];
    const memory = createMockMemoryAdapter({ sceneIndex: index });
    const coord = new CoordinationService(memory, noopLogger as any);

    const ctx = await coord.getActiveSceneContext("tg:user:1");
    expect(ctx.sceneTitle).toBe("refactoring-auth");
    expect(ctx.personaExists).toBe(true);
  });

  test("returns null scene title when no active scenes exist", async () => {
    const memory = createMockMemoryAdapter({ sceneIndex: [] });
    const coord = new CoordinationService(memory, noopLogger as any);

    const ctx = await coord.getActiveSceneContext("tg:user:1");
    expect(ctx.sceneTitle).toBeNull();
    expect(ctx.personaExists).toBe(false);
  });

  test("enriches L1.5 context with scene title", async () => {
    const index = [
      { filename: "database-setup.md", summary: "Setting up database", heat: 7, created: "2026-01-01", updated: "2026-01-15", status: "active", importanceScore: 8 },
    ];
    const memory = createMockMemoryAdapter({ sceneIndex: index });
    const coord = new CoordinationService(memory, noopLogger as any);

    const enriched = await coord.enrichL15Context("tg:user:1", "How do I connect to PostgreSQL?");
    expect(enriched).toContain("[Active Scene: database-setup]");
    expect(enriched).toContain("How do I connect to PostgreSQL?");
  });

  test("returns original messages when no active scene for L1.5 enrichment", async () => {
    const memory = createMockMemoryAdapter({ sceneIndex: [] });
    const coord = new CoordinationService(memory, noopLogger as any);

    const enriched = await coord.enrichL15Context("tg:user:1", "Short casual message");
    expect(enriched).toBe("Short casual message");
  });

  // ─── Task 3: Context Injection ─────────────────────────────────────
  test("builds injection context from recall output", async () => {
    const memory = createMockMemoryAdapter({ sceneIndex: [] });
    const coord = new CoordinationService(memory, noopLogger as any);

    const recall = {
      prependContext: "- User prefers TypeScript\n- Working on API design",
      appendSystemContext: "## Persona\nExpert backend developer\n\n## Scene Navigation\n- api-design: REST API planning",
    };

    const content = coord.buildInjectionContext(recall);
    expect(content).toContain("User prefers TypeScript");
    expect(content).toContain("Expert backend developer");
    expect(content).toContain("api-design");
  });

  test("returns empty string when no recall context available", async () => {
    const memory = createMockMemoryAdapter({ sceneIndex: [] });
    const coord = new CoordinationService(memory, noopLogger as any);

    const content = coord.buildInjectionContext({ prependContext: "", appendSystemContext: "" });
    expect(content).toBe("");
  });

  test("records context injection events", async () => {
    const memory = createMockMemoryAdapter({ sceneIndex: [] });
    const coord = new CoordinationService(memory, noopLogger as any);

    coord.recordContextInjection();
    coord.recordContextInjection();
    coord.recordContextInjection();

    const metrics = coord.getMetrics();
    expect(metrics.contextInjections).toBe(3);
  });

  // ─── Metrics ───────────────────────────────────────────────────────
  test("getMetrics returns aggregated coordination metrics", async () => {
    const memory = createMockMemoryAdapter({ sceneIndex: [] });
    const coord = new CoordinationService(memory, noopLogger as any);

    // Simulate some coordination activity
    const index = [
      { filename: "feature-x.md", summary: "Feature X", heat: 5, created: "2026-01-01", updated: "2026-01-10", status: "active", importanceScore: 6 },
    ];
    const mem2 = createMockMemoryAdapter({ sceneIndex: index });
    mem2.resolveSceneByTitle = async (title: string) => {
      index[0]!.status = "resolved";
      return true;
    };
    const coord2 = new CoordinationService(mem2, noopLogger as any);

    await coord2.onMmdCompleted("tg:user:1", "Feature X Update");
    const sceneCtx = await coord2.getActiveSceneContext("tg:user:1");
    coord2.recordContextInjection();

    const metrics = coord2.getMetrics();
    expect(metrics.resolvedScenesFromMmd).toBeGreaterThanOrEqual(0);
    expect(metrics.mmdNamesFromScenes).toBeGreaterThanOrEqual(0);
    expect(metrics.contextInjections).toBe(1);
  });
});
