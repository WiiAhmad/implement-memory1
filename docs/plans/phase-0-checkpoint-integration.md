# Phase 0: Checkpoint Integration Strategy — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `memory_autonomy_state` namespace in the existing TDAI checkpoint file, providing the foundation for all catch-up triggers in subsequent phases.

**Spec reference:** Sections 5.5–5.6, 8.1, 8.4–8.5

**Prerequisites:** None (this is the base infrastructure)

---

## File structure

### Creates or modifies

- Create: `src/memory/autonomy-checkpoint.ts` — `MemoryAutonomyCheckpoint` class
- Create: `src/memory/autonomy-checkpoint.test.ts` — unit tests
- Modify: `src/config/env.ts` — add checkpoint-related env vars + feature gates
- Modify: `src/config/env.test.ts` — assertions for new vars
- Modify: `src/memory/build-memory-config.ts` — add autonomy config section
- Modify: `.env.example` — document new vars

---

## Task 1: Add env vars and config types

### Step 1: Write failing env tests

Add to `src/config/env.test.ts`:

```ts
test("parses autonomy checkpoint env vars with defaults", () => {
  // Assert MEMORY_SCHEDULER_PHASE defaults to "none"
  // Assert MEMORY_L2_FORCE_AFTER_IDLE_ENABLED defaults to "true"
  // Assert MEMORY_L2_STARTUP_RECOVERY_ENABLED defaults to "false"
  // Assert MEMORY_L2_STALE_REFRESH_ENABLED defaults to "false"
  // Assert MEMORY_PERSONA_STALE_REFRESH_ENABLED defaults to "true"
  // Assert MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED defaults to "true"
  // Assert MEMORY_SCENE_ARCHIVE_ENABLED defaults to "false"
  // Assert MEMORY_SCENE_MERGE_ENABLED defaults to "false"
  // Assert OFFLOAD_RECLAIM_ENABLED defaults to "false"
  // Assert OFFLOAD_L2_WAIT_RETRY_ENABLED defaults to "false"
});
```

- [ ] Write test case
- [ ] Run `bun test src/config/env.test.ts` — verify FAIL

### Step 2: Add env vars to schema

Add to `EnvSchema` in `src/config/env.ts`:

```ts
  // ── Autonomy Checkpoint Config ──────────────────────────────────────────
  MEMORY_SCHEDULER_PHASE: z.enum(["none", "observer", "active"]).default("none"),
  MEMORY_AUTONOMY_CHECKPOINT_NAMESPACE: z.string().default("memory_autonomy_state"),
  MEMORY_AUTONOMY_CHECKPOINT_FILE_LOCK_ENABLED: boolString.default("true"),

  // ── TDAI Memory Feature Gates ────────────────────────────────────────────
  MEMORY_L2_FORCE_AFTER_IDLE_ENABLED: boolString.default("true"),
  MEMORY_L2_STARTUP_RECOVERY_ENABLED: boolString.default("false"),
  MEMORY_L2_STALE_REFRESH_ENABLED: boolString.default("false"),
  MEMORY_PERSONA_STALE_REFRESH_ENABLED: boolString.default("true"),
  MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED: boolString.default("true"),
  MEMORY_SCENE_ARCHIVE_ENABLED: boolString.default("false"),
  MEMORY_SCENE_MERGE_ENABLED: boolString.default("false"),

  // ── Offload Feature Gates ────────────────────────────────────────────────
  OFFLOAD_RECLAIM_ENABLED: boolString.default("false"),
  OFFLOAD_L2_WAIT_RETRY_ENABLED: boolString.default("false"),
```

Add an `autonomy` field to `AppEnv`:

```ts
  autonomy: {
    schedulerPhase: parsed.MEMORY_SCHEDULER_PHASE,
    checkpointNamespace: parsed.MEMORY_AUTONOMY_CHECKPOINT_NAMESPACE,
    checkpointFileLockEnabled: parsed.MEMORY_AUTONOMY_CHECKPOINT_FILE_LOCK_ENABLED,
    featureGates: {
      l2ForceAfterIdle: parsed.MEMORY_L2_FORCE_AFTER_IDLE_ENABLED,
      l2StartupRecovery: parsed.MEMORY_L2_STARTUP_RECOVERY_ENABLED,
      l2StaleRefresh: parsed.MEMORY_L2_STALE_REFRESH_ENABLED,
      personaStaleRefresh: parsed.MEMORY_PERSONA_STALE_REFRESH_ENABLED,
      personaForceIfMissing: parsed.MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED,
      sceneArchive: parsed.MEMORY_SCENE_ARCHIVE_ENABLED,
      sceneMerge: parsed.MEMORY_SCENE_MERGE_ENABLED,
      offloadReclaim: parsed.OFFLOAD_RECLAIM_ENABLED,
      offloadL2WaitRetry: parsed.OFFLOAD_L2_WAIT_RETRY_ENABLED,
    },
```

- [ ] Implement schema additions
- [ ] Add `autonomy` to `AppEnv` and `parseEnv()` return value
- [ ] Add `DlmmAutonomyConfig` type (or extend `OffloadConfig`/`MemoryConfig`)
- [ ] Run `bun test src/config/env.test.ts` — verify PASS

### Step 3: Add env vars to `.env.example`

```dotenv
# ── Autonomy Checkpoint & Scheduler ──────────────────────────────────────────
MEMORY_SCHEDULER_PHASE=none       # none | observer | active
MEMORY_AUTONOMY_CHECKPOINT_NAMESPACE=memory_autonomy_state
MEMORY_AUTONOMY_CHECKPOINT_FILE_LOCK_ENABLED=true
MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=true
MEMORY_L2_STARTUP_RECOVERY_ENABLED=false
MEMORY_L2_STALE_REFRESH_ENABLED=false
MEMORY_PERSONA_STALE_REFRESH_ENABLED=true
MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED=true
MEMORY_SCENE_ARCHIVE_ENABLED=false
MEMORY_SCENE_MERGE_ENABLED=false
OFFLOAD_RECLAIM_ENABLED=false
OFFLOAD_L2_WAIT_RETRY_ENABLED=false
```

- [ ] Append to `.env.example`

---

## Task 2: Implement `MemoryAutonomyCheckpoint` class

### Step 1: Write failing tests

Create `src/memory/autonomy-checkpoint.test.ts`:

```ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAutonomyCheckpoint } from "./autonomy-checkpoint.ts";

let tmpDir: string;
let checkpoint: MemoryAutonomyCheckpoint;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "autonomy-checkpoint-"));
  checkpoint = new MemoryAutonomyCheckpoint(tmpDir);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("MemoryAutonomyCheckpoint", () => {
  test("returns default state for unknown session", async () => {
    const state = await checkpoint.getState("tg:user:unknown");
    expect(state.lastMemorySeqExtracted).toBe(0);
    expect(state.lastMemorySeqProcessedByL2).toBe(0);
    expect(state.lastL1CompletedAt).toBeNull();
    expect(state.lastL2CompletedAt).toBeNull();
    expect(state.l2JobStatus).toBe("idle");
    expect(state.personaJobStatus).toBe("idle");
    expect(state.sessionIsCold).toBe(false);
  });

  test("round-trips state through get/update", async () => {
    const sessionKey = "tg:user:test1";
    await checkpoint.updateState(sessionKey, {
      lastMemorySeqExtracted: 10,
      lastMemorySeqProcessedByL2: 7,
      lastL1CompletedAt: "2026-05-26T10:00:00.000Z",
      l2JobStatus: "running",
    });

    const state = await checkpoint.getState(sessionKey);
    expect(state.lastMemorySeqExtracted).toBe(10);
    expect(state.lastMemorySeqProcessedByL2).toBe(7);
    expect(state.lastL1CompletedAt).toBe("2026-05-26T10:00:00.000Z");
    expect(state.l2JobStatus).toBe("running");

    // Unchanged fields keep defaults
    expect(state.lastL2CompletedAt).toBeNull();
    expect(state.sessionIsCold).toBe(false);
  });

  test("coexists with existing pipeline state", async () => {
    const sessionKey = "tg:user:test2";
    // Simulate existing pipeline write by writing directly to the checkpoint file
    const checkpointPath = path.join(tmpDir, ".metadata", "recall_checkpoint.json");
    await writeFile(checkpointPath, JSON.stringify({
      last_captured_timestamp: "2026-01-01T00:00:00.000Z",
      total_processed: 5,
      runner_states: {},
      pipeline_states: {
        [sessionKey]: {
          conversation_count: 10,
          l2_pending_l1_count: 3,
          last_extraction_time: 1700000000000,
          l2_last_extraction_time: 1700000000000,
          last_active_time: 1700000000000,
          warmup_threshold: 10,
        },
      },
    }), "utf8");

    // Write autonomy state alongside it
    await checkpoint.updateState(sessionKey, {
      lastMemorySeqExtracted: 8,
      l2JobStatus: "idle",
    });

    // Verify pipeline state is intact
    const raw = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(raw.pipeline_states[sessionKey].conversation_count).toBe(10);
    expect(raw.memory_autonomy_state[sessionKey].lastMemorySeqExtracted).toBe(8);
  });

  test("migrates from existing PipelineSessionState when autonomy key missing", async () => {
    const sessionKey = "tg:user:migrate";
    const checkpointPath = path.join(tmpDir, ".metadata", "recall_checkpoint.json");
    // Write only pipeline state, no autonomy state
    await writeFile(checkpointPath, JSON.stringify({
      pipeline_states: {
        [sessionKey]: {
          conversation_count: 15,
          l2_pending_l1_count: 3,
          last_extraction_time: 1700000000000,
          l2_last_extraction_time: 1699990000000,
          last_active_time: 1700005000000,
          warmup_threshold: 10,
        },
      },
    }), "utf8");

    // First read triggers migration
    const state = await checkpoint.getState(sessionKey);
    // l2_pending_l1_count=3 means 3 pending → set extracted=3, processed=0 → delta=3 → triggers fire
    expect(state.lastMemorySeqExtracted).toBe(3);
    expect(state.lastMemorySeqProcessedByL2).toBe(0);
    // Timestamps converted from epoch ms
    expect(state.lastL1CompletedAt).toBe(new Date(1700000000000).toISOString());
    expect(state.lastL2CompletedAt).toBe(new Date(1699990000000).toISOString());
    expect(state.sessionLastActiveAt).toBe(new Date(1700005000000).toISOString());
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/memory/autonomy-checkpoint.test.ts` — verify FAIL

### Step 2: Implement checkpoint class

Create `src/memory/autonomy-checkpoint.ts`:

```ts
import { CheckpointManager } from "../../TencentDB-Agent-Memory/src/utils/checkpoint.ts";
import path from "node:path";

export interface MemoryCheckpointState {
  // Sequencing counters
  lastMemorySeqExtracted: number;
  lastMemorySeqProcessedByL2: number;
  lastSceneSeqExtracted: number;
  lastSceneSeqProcessedByPersona: number;

  // Timestamps (ISO-8601 or null)
  lastL1CompletedAt: string | null;
  lastL2CompletedAt: string | null;
  lastPersonaAt: string | null;
  lastMeaningfulMemoryAt: string | null;
  sceneIndexUpdatedAt: string | null;

  // Job guards
  l2JobStatus: "idle" | "running" | "scheduled";
  personaJobStatus: "idle" | "running";

  // Activity signals
  sessionLastActiveAt: string;
  sessionIsCold: boolean;
}

export const DEFAULT_AUTONOMY_STATE: MemoryCheckpointState = {
  lastMemorySeqExtracted: 0,
  lastMemorySeqProcessedByL2: 0,
  lastSceneSeqExtracted: 0,
  lastSceneSeqProcessedByPersona: 0,
  lastL1CompletedAt: null,
  lastL2CompletedAt: null,
  lastPersonaAt: null,
  lastMeaningfulMemoryAt: null,
  sceneIndexUpdatedAt: null,
  l2JobStatus: "idle",
  personaJobStatus: "idle",
  sessionLastActiveAt: new Date(0).toISOString(),
  sessionIsCold: false,
};

export class MemoryAutonomyCheckpoint {
  private readonly cpManager: CheckpointManager;
  private readonly dataDir: string;
  private readonly namespace: string;
  private readonly fileLockEnabled: boolean;
  private migrated = false;

  constructor(dataDir: string, namespace = "memory_autonomy_state", fileLockEnabled = true) {
    this.dataDir = dataDir;
    this.namespace = namespace;
    this.fileLockEnabled = fileLockEnabled;
    if (fileLockEnabled) {
      this.cpManager = new CheckpointManager(dataDir);
    } else {
      // Without file lock: use raw readFile/writeFile with JSON parse/stringify.
      // The cpManager lock is bypassed — caller assumes responsibility for concurrency.
      this.cpManager = null as any;
    }
  }

  private async readRaw(): Promise<any> {
    if (this.fileLockEnabled) {
      return this.cpManager.read();
    }
    // Fallback: direct file read without lock
    const checkpointPath = path.join(this.dataDir, ".metadata", "recall_checkpoint.json");
    try {
      return JSON.parse(await readFile(checkpointPath, "utf8"));
    } catch {
      return {};
    }
  }

  private async writeRaw(cp: any): Promise<void> {
    if (this.fileLockEnabled) {
      await this.cpManager.write(cp);
      return;
    }
    // Fallback: direct file write without lock
    const checkpointPath = path.join(this.dataDir, ".metadata", "recall_checkpoint.json");
    const tmp = checkpointPath + ".tmp";
    await writeFile(tmp, JSON.stringify(cp, null, 2), "utf8");
    await rename(tmp, checkpointPath);
  }

  async getState(sessionKey: string): Promise<MemoryCheckpointState> {
    const cp = await this.cpManager.read();

    // One-time migration from PipelineSessionState if autonomy namespace missing
    if (!cp[this.namespace] && !this.migrated) {
      await this.migrateFromPipelineState(cp);
      this.migrated = true;
      // Re-read after migration
      const cp2 = await this.cpManager.read();
      return this.extractState(cp2, sessionKey);
    }

    return this.extractState(cp, sessionKey);
  }

  async updateState(
    sessionKey: string,
    patch: Partial<MemoryCheckpointState>,
  ): Promise<void> {
    // Atomic read-modify-write via CheckpointManager's internal lock
    // by using the file-level mutation pattern
    const cp = await this.cpManager.read();
    if (!cp[this.namespace]) cp[this.namespace] = {};
    const current = this.mergeDefaults(cp[this.namespace][sessionKey]);
    cp[this.namespace][sessionKey] = { ...current, ...patch };
    await this.cpManager.write(cp);
  }

  async updateStates(
    patches: Record<string, Partial<MemoryCheckpointState>>,
  ): Promise<void> {
    const cp = await this.cpManager.read();
    if (!cp[this.namespace]) cp[this.namespace] = {};
    for (const [sessionKey, patch] of Object.entries(patches)) {
      const current = this.mergeDefaults(cp[this.namespace][sessionKey]);
      cp[this.namespace][sessionKey] = { ...current, ...patch };
    }
    await this.cpManager.write(cp);
  }

  private extractState(cp: any, sessionKey: string): MemoryCheckpointState {
    const autonomy = cp[this.namespace] ?? {};
    return this.mergeDefaults(autonomy[sessionKey]);
  }

  private mergeDefaults(raw: any): MemoryCheckpointState {
    const base = { ...DEFAULT_AUTONOMY_STATE };
    if (!raw || typeof raw !== "object") return base;
    return { ...base, ...raw };
  }

  private async migrateFromPipelineState(cp: any): Promise<void> {
    const pipelineStates = cp.pipeline_states ?? {};
    const autonomyState: Record<string, any> = {};

    for (const [sessionKey, ps] of Object.entries(pipelineStates) as [string, any][]) {
      autonomyState[sessionKey] = {
        lastMemorySeqExtracted: ps.l2_pending_l1_count ?? 0,
        lastMemorySeqProcessedByL2: 0,
        lastSceneSeqExtracted: 0,
        lastSceneSeqProcessedByPersona: 0,
        lastL1CompletedAt: ps.last_extraction_time
          ? new Date(ps.last_extraction_time).toISOString()
          : null,
        lastL2CompletedAt: ps.l2_last_extraction_time
          ? new Date(ps.l2_last_extraction_time).toISOString()
          : null,
        lastPersonaAt: null,
        lastMeaningfulMemoryAt: null,
        sceneIndexUpdatedAt: null,
        l2JobStatus: "idle",
        personaJobStatus: "idle",
        sessionLastActiveAt: ps.last_active_time
          ? new Date(ps.last_active_time).toISOString()
          : new Date(0).toISOString(),
        sessionIsCold: false,
      };
    }

    cp[this.namespace] = autonomyState;
    await this.cpManager.write(cp);
  }
}
```

- [ ] Implement class with all methods
- [ ] Run `bun test src/memory/autonomy-checkpoint.test.ts` — verify PASS

### Step 3: Wire into build-memory-config

Add autonomy section to `src/memory/build-memory-config.ts`:

```ts
export interface AutonomyConfig {
  schedulerPhase: "none" | "observer" | "active";
  checkpointNamespace: string;
  checkpointFileLockEnabled: boolean;
  featureGates: {
    l2ForceAfterIdle: boolean;
    l2StartupRecovery: boolean;
    l2StaleRefresh: boolean;
    personaStaleRefresh: boolean;
    personaForceIfMissing: boolean;
    sceneArchive: boolean;
    sceneMerge: boolean;
    offloadReclaim: boolean;
    offloadL2WaitRetry: boolean;
  };
}
```

- [ ] Add type and wire into config builder
- [ ] Run `bun test src/memory/build-memory-config.test.ts` — verify PASS

---

## Task 3: Verify Phase 0 together

- [ ] Run focused tests:

```bash
bun test src/config/env.test.ts src/memory/autonomy-checkpoint.test.ts src/memory/build-memory-config.test.ts
```

Expected: PASS.

- [ ] Run full unit suite:

```bash
bun run test
```

Expected: PASS (pre-existing vendor test failures are acceptable; all root app tests pass).

- [ ] Build:

```bash
bun run build
```

Expected: PASS.

---

## Self-review

- [ ] All env vars have proper Zod schema with defaults
- [ ] Feature gates are boolean, default to `false` for risky behaviors
- [ ] `MemoryAutonomyCheckpoint` uses `CheckpointManager` lock, not independent file I/O
- [ ] Migration from `PipelineSessionState` is idempotent (re-runs if crash mid-write)
- [ ] `memory_autonomy_state` key co-exists with `pipeline_states` without overwriting
- [ ] No vendor edits to `TencentDB-Agent-Memory/` required
