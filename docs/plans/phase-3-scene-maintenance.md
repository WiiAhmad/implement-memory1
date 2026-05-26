# Phase 3: Scene Maintenance — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep scenes organized and bounded. Add metadata schema, status lifecycle, active/stale/archive injection policy, and duplicate detection/merge.

**Spec reference:** Sections 5.3, 8.1, 11 (Phase 3a, 3b, 3c)

**Prerequisites:** Phase 2 (scheduler exists for triggering scene maintenance)

---

## File structure

### Creates or modifies

**Phase 3a — Scene Metadata (requires vendor edits in `TencentDB-Agent-Memory/src/core/scene/`):**
- Modify: `TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts` — write metadata on scene creation
- Modify: `TencentDB-Agent-Memory/src/core/scene/scene-format.ts` — add `SceneMetadata` interface
- Modify: `TencentDB-Agent-Memory/src/core/scene/scene-index.ts` — add metadata fields to index
- Create: `src/memory/scene-metadata.ts` — root-side scene metadata reader/aggregator
- Create: `src/memory/scene-metadata.test.ts` — tests

**Phase 3b — Injection Policy (root code only):**
- Create: `src/memory/scene-injection.ts` — scene selection + injection budget logic
- Create: `src/memory/scene-injection.test.ts` — tests
- Modify: `src/memory/tencent-memory-adapter.ts` — apply injection policy in `buildMemoryContext()` (the method that assembles recalled memory context for prompting)

**Phase 3c — Duplicate Detection (requires vendor edits in `TencentDB-Agent-Memory/src/core/store/`):**
- Modify: `TencentDB-Agent-Memory/src/core/store/sqlite.ts` or `bm25-client.ts` — add similarity check
- Modify: `TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts` — merge-on-create logic
- Create: `src/memory/scene-dedup.ts` — root-side dedup orchestrator
- Create: `src/memory/scene-dedup.test.ts` — tests

---

## Task 1: Pre-audit TDAI scene schema (prerequisite)

Before writing any code, audit the vendored scene module to verify the spec's assumptions.

- [ ] Read `TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts` — understand current scene creation flow
- [ ] Read `TencentDB-Agent-Memory/src/core/scene/scene-format.ts` — understand scene format and extract method
- [ ] Read `TencentDB-Agent-Memory/src/core/scene/scene-index.ts` — understand index structure
- [ ] Read `TencentDB-Agent-Memory/src/core/store/sqlite.ts` — understand store query capabilities
- [ ] Document findings in `docs/backups/2026-05-26-scene-audit.md`
- [ ] File TDAI vendor PR for Phase 3a changes (scene metadata schema)

---

## Phase 3a: Scene Metadata and Status

### Step 1: Add `SceneMetadata` schema (vendor edit)

In `TencentDB-Agent-Memory/src/core/scene/scene-format.ts`:

```ts
export interface SceneMetadata {
  sceneId: string;
  title: string;
  status: "active" | "stale" | "resolved" | "archived";
  createdAt: string;        // ISO-8601
  updatedAt: string;        // ISO-8601
  lastReferencedAt: string; // ISO-8601
  memoryCount: number;
  importanceScore: number;
  topicHash?: string;
}
```

- [ ] Add `SceneMetadata` interface
- [ ] Add default metadata factory function
- [ ] Write tests for metadata creation

### Step 2: Update pipeline to write metadata (vendor edit)

In `TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts`:

- [ ] On scene creation: write metadata alongside scene `.md` file
- [ ] On scene update: update `updatedAt`, `memoryCount`, `importanceScore`
- [ ] On scene read: parse metadata from file or default if missing
- [ ] Add `updateSceneMetadata()` method
- [ ] Add migration path for existing scenes without metadata

### Step 3: Update scene index (vendor edit)

In `TencentDB-Agent-Memory/src/core/scene/scene-index.ts`:

- [ ] Add `status`, `importanceScore`, `updatedAt` to index entries
- [ ] Expose `getScenesByStatus(status)` for injection policy
- [ ] Add `lastReferencedAt` tracking

### Step 4: Root-side metadata aggregator

Create `src/memory/scene-metadata.ts`:

```ts
export class SceneMetadataService {
  constructor(private readonly dataDir: string) {}

  async getSceneCounts(): Promise<{ active: number; stale: number; archived: number }> {
    // Read scene index, count by status
  }

  async getSceneImportance(sessionKey: string): Promise<SceneImportanceReport> {
    // Read all scene metadata, compute importance scores
  }

  async getStaleScenes(staleAfterDays: number): Promise<string[]> {
    // Return scene IDs where updatedAt + staleAfterDays < now
  }
}
```

- [ ] Implement metadata reader
- [ ] Implement stale scene detector
- [ ] Run `bun test src/memory/scene-metadata.test.ts` — verify PASS

---

## Phase 3b: Active/Stale/Archive Injection Policy

### Step 1: Write failing tests

Create `src/memory/scene-injection.test.ts`:

```ts
describe("SceneInjectionPolicy", () => {
  test("picks active scenes up to budget", async () => {
    // 40 active scenes, maxActive = 30 → picks 30 highest importance
  });

  test("includes stale scenes only when relevant", async () => {
    // stale scene with matching keywords → included
    // stale scene without match → excluded
  });

  test("excludes archived scenes from default injection", async () => {
    // archived scene → not in active set
  });

  test("includes archived scenes when explicitly recalled", async () => {
    // memory recall matches archived scene → included
  });

  test("respects token budget for scene navigation", async () => {
    // scenes truncated to fit token budget
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/memory/scene-injection.test.ts` — verify FAIL

### Step 2: Implement injection policy

Create `src/memory/scene-injection.ts`:

```ts
export interface SceneInjectionConfig {
  maxActive: number;
  staleAfterDays: number;
  archiveAfterDays: number;
  maxTokenBudget: number;
}

export class SceneInjectionPolicy {
  constructor(
    private readonly dataDir: string,
    private readonly config: SceneInjectionConfig,
  ) {}

  async selectScenesForInjection(
    sessionKey: string,
    query?: string,
  ): Promise<InjectedScene[]> {
    // 1. Read scene index
    // 2. Filter archived scenes (exclude unless explicitly matched by recall)
    // 3. Sort active scenes by importance, take top maxActive
    // 4. If token budget remains, include stale scenes with relevance > threshold
    // 5. Serialize scene titles/descriptions within token budget
    // 6. Return selected scenes
  }

  async applyStaleTransition(): Promise<void> {
    // Mark scenes with no activity for staleAfterDays as "stale"
  }

  async applyArchiveTransition(): Promise<void> {
    // Mark stale scenes older than archiveAfterDays as "archived"
  }
}
```

- [ ] Implement scene selection algorithm
- [ ] Implement stale/archive transitions
- [ ] Run `bun test src/memory/scene-injection.test.ts` — verify PASS

### Step 3: Wire into adapter

Modify `src/memory/tencent-memory-adapter.ts` in `buildMemoryContext()` (the method that produces the context blob for injection into LLM prompts):

- [ ] After recalling memories, apply `SceneInjectionPolicy.selectScenesForInjection()`
- [ ] Cap injected scene navigation by token budget
- [ ] Run existing memory adapter tests — verify PASS

---

## Phase 3c: Duplicate Detection and Merge

### Step 1: Add topic hash or embedding comparison (vendor edit)

In `TencentDB-Agent-Memory/src/core/store/sqlite.ts` or a new similarity module:

```ts
export async function findSimilarScenes(
  store: StoreContext,
  topicText: string,
  threshold: number,
): Promise<SceneMatch[]> {
  // Option A: Topic hash (fast, no external deps)
  // - Compute hash from scene title keywords
  // - Lookup by hash prefix
  //
  // Option B: Embedding similarity (requires embedding service)
  // - Query vector store for cosine similarity > threshold
  // - Return matches sorted by similarity
}
```

- [ ] Implement similarity search (Option A first: topic hash)
- [ ] Add `topicHash` to `SceneMetadata`
- [ ] Write tests for similarity matching

### Step 2: Add merge-on-create logic (vendor edit)

In `TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts`:

- [ ] Before creating a new scene, check for similar existing scenes
- [ ] If similarity > `MEMORY_SCENE_MERGE_THRESHOLD`, append to existing scene instead
- [ ] Update metadata: increment `memoryCount`, update `updatedAt`, recompute `importanceScore`
- [ ] Log merge decision with similarity score
- [ ] Write tests for merge behavior

### Step 3: Root-side dedup orchestrator

Create `src/memory/scene-dedup.ts`:

```ts
export class SceneDedupService {
  constructor(
    private readonly dataDir: string,
    private readonly config: { mergeThreshold: number; enabled: boolean },
  ) {}

  async batchDedup(sessionKey: string): Promise<DedupResult> {
    // 1. Read all scenes for session
    // 2. Compare each pair for similarity
    // 3. Merge pairs above threshold
    // 4. Log merged=N, skipped=N
    // Return { merged: number, skipped: number, errors: string[] }
  }
}
```

- [ ] Write failing tests for batch dedup
- [ ] Implement dedup orchestrator
- [ ] Run tests — verify PASS

---

## Task 2: Add scene maintenance env vars

Add to `EnvSchema`:

```ts
  MEMORY_SCENE_STALE_AFTER_DAYS: z.coerce.number().int().positive().default(7),
  MEMORY_SCENE_ARCHIVE_AFTER_DAYS: z.coerce.number().int().positive().default(21),
  MEMORY_SCENE_MERGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.86),
```

- [ ] Implement schema additions
- [ ] Run env tests — verify PASS

---

## Task 3: Wire scene maintenance into scheduler

- [ ] Add scene maintenance triggers to `Scheduler`:
  - On L2 completion: check and apply stale/archive transitions
  - On L2 completion: run batch dedup if enabled
- [ ] Add feature gate checks before running
- [ ] Log maintenance actions per spec Section 9.1

---

## Task 4: Verify Phase 3 together

- [ ] Run focused tests:

```bash
bun test src/memory/scene-metadata.test.ts src/memory/scene-injection.test.ts src/memory/scene-dedup.test.ts src/services/scheduler.test.ts
```

Expected: PASS.

- [ ] Run full unit suite:

```bash
bun run test
```

Expected: PASS.

- [ ] Build:

```bash
bun run build
```

Expected: PASS.

- [ ] Vendor tests: run inside `TencentDB-Agent-Memory/` to verify vendor edits don't break existing tests

---

## Self-review

- [ ] Phase 3a vendor edit adds `SceneMetadata` without breaking existing scene file format
- [ ] Phase 3b injection policy lives in root `src/memory/` — no vendor edit needed
- [ ] Phase 3c vendor edit uses topic hash option first; embedding option is additive
- [ ] All scene maintenance is gated by feature flags (default off for archive/merge)
- [ ] Archived scenes remain searchable via recall — only injection is skipped
- [ ] Merge preserves memory history from both source scenes
- [ ] All decisions are logged with reasons per spec Section 9.1
- [ ] Scene importance score formula matches spec Section 5.3
