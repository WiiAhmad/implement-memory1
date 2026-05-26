# Scheduler Migration — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate L2/L3 scheduling responsibility from the vendored `MemoryPipelineManager` to the new global `Scheduler` (from Phase 2) across three incremental phases. No double-fire, no behavioral gaps.

**Spec reference:** Sections 14.1–14.7

**Prerequisites:** Phase 0 (checkpoint), Phase 1 (logging), Phase 2 (scheduler exists in observer/active mode)

---

## File structure

### Creates or modifies

- Create: `src/services/scheduler.ts` — extended from Phase 2 with polling bridge + timer management
- Create: `src/services/scheduler.test.ts` — extended from Phase 2 tests
- Create: `src/services/polling-bridge.ts` — checkpoint file watcher for Phase 2 of migration
- Create: `src/services/polling-bridge.test.ts` — tests
- Modify: `src/main.ts` — wire scheduler phase-based lifecycle
- Modify: `src/config/env.ts` — add `MEMORY_SCHEDULER_PHASE` if not already present

---

## Task 1: Phase 1 — Observer Mode (no behavioral change)

Already partially covered in Phase 2 Task 2. This task adds the polling bridge that reads checkpoint state to evaluate what the scheduler *would* do.

### Step 1: Write failing observer mode tests

```ts
describe("Scheduler observer mode", () => {
  test("logs observer decisions without dispatching", async () => {
    // Set phase=observer
    // Call evaluateAndDispatchL2 with trigger conditions met
    // Verify log contains [scheduler] [observer] dispatch would_l2 session=... reason=...
    // Verify runL2 was NOT called
  });

  test("produces observer logs that match old scheduler behavior", async () => {
    // Both schedulers run on same checkpoint state
    // Verify observer logs match what old scheduler actually does
    // (Integration-level test requiring both schedulers)
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/services/scheduler.test.ts` — verify FAIL

### Step 2: Implement observer log-only mode

In `src/services/scheduler.ts`:

```ts
private async dispatchIfActive(
  job: "L2" | "persona",
  sessionKey: string,
  trigger: string,
  dispatchFn: () => Promise<void>,
): Promise<void> {
  if (this.phase === "observer") {
    this.logger.info(
      `[scheduler] [observer] dispatch would_${job.toLowerCase()} ` +
      `session=${sessionKey} trigger=${trigger}`,
    );
    return;
  }

  if (this.phase === "active") {
    this.logger.info(
      `[scheduler] dispatch session=${sessionKey} job=${job} trigger=${trigger}`,
    );
    await dispatchFn();
    this.logger.info(
      `[scheduler] complete session=${sessionKey} job=${job}`,
    );
  }
}
```

- [ ] Implement observer dispatch wrapper
- [ ] Integrate into all trigger evaluation points
- [ ] Run tests — verify PASS

---

## Task 2: Phase 2 — Polling Bridge for L2 Catch-Up Triggers

In this phase, the new scheduler takes over L2 trigger decisions. Since we cannot modify `MemoryPipelineManager` internals without a vendor edit, we use a polling bridge to detect L1 completions and session activity.

### Step 1: Write polling bridge tests

Create `src/services/polling-bridge.test.ts`:

```ts
describe("PollingBridge", () => {
  test("detects L1 completion via checkpoint l2_pending_l1_count change", async () => {
    // Mock checkpoint file with known pipeline_states
    // First read: l2_pending_l1_count=5
    // Second read: l2_pending_l1_count=7 (L1 completed twice)
    // Verify onL1Completed was called twice
  });

  test("detects session activity via last_active_time change", async () => {
    // First read: last_active_time=1000
    // Second read: last_active_time=2000
    // Verify onSessionActivity was called
  });

  test("does not fire on unchanged state", async () => {
    // Same values on consecutive reads
    // Verify no callbacks fired
  });

  test("handles missing pipeline_states gracefully", async () => {
    // Checkpoint file exists but has no pipeline_states key
    // Verify no crash, clean start
  });

  test("polls at configured interval", async () => {
    // Default 2s interval
    // Verify readCheckpoint called at approximately 2s intervals
  });

  test("stops polling on close", async () => {
    // After close(), verify polling stops
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/services/polling-bridge.test.ts` — verify FAIL

### Step 2: Implement polling bridge

Create `src/services/polling-bridge.ts`:

```ts
// Callback names match the Scheduler methods they map to in Phase 2's scheduler.ts:
//   onL1Completed(sessionKey)  →  scheduler.onL1Completed(sessionKey)
//   onSessionActivity(sessionKey)  →  scheduler.notifyActivity(sessionKey)
// The name asymmetry is intentional — they describe what the bridge detected,
// not what the scheduler does in response.
export interface PollingBridgeCallbacks {
  onL1Completed(sessionKey: string): void;
  onSessionActivity(sessionKey: string): void;
}

export class PollingBridge {
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousState: Record<string, { l1PendingCount: number; lastActiveTime: number }> = {};

  constructor(
    private readonly checkpointFile: string,
    private readonly callbacks: PollingBridgeCallbacks,
    private readonly pollIntervalMs: number = 2000,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      const raw = await readFile(this.checkpointFile, "utf8");
      const cp = JSON.parse(raw);
      const pipelineStates = cp.pipeline_states ?? {};

      for (const [sessionKey, ps] of Object.entries(pipelineStates)) {
        const prev = this.previousState[sessionKey];
        const current = {
          l1PendingCount: (ps as any).l2_pending_l1_count ?? 0,
          lastActiveTime: (ps as any).last_active_time ?? 0,
        };

        if (prev) {
          if (current.l1PendingCount > prev.l1PendingCount) {
            this.callbacks.onL1Completed(sessionKey);
          }
          if (current.lastActiveTime > prev.lastActiveTime) {
            this.callbacks.onSessionActivity(sessionKey);
          }
        }

        this.previousState[sessionKey] = current;
      }
    } catch {
      // File not found or parse error — skip this poll cycle
    }
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] Implement polling bridge
- [ ] Run tests — verify PASS

### Step 3: Indirectly disable old scheduler's L2 timers

Wrap `MemoryPipelineManager` via config overrides:

| Old trigger | Indirect disable method |
|---|---|
| `advanceL2Timer()` after L1 | Set `MEMORY_L2_DELAY_AFTER_L1=604800` (7 days) — timer fires far in future |
| `armL2MaxInterval()` after L2 | Set `MEMORY_L2_MAX_INTERVAL=604800` (7 days) |
| `recoverPendingSessions()` at boot | New scheduler's startup recovery runs first and dispatches before old timer |

- [ ] Document override values in deployment config
- [ ] Add config comment block warning about overrides

### Step 4: Wire polling bridge into scheduler lifecycle

Modify `src/services/scheduler.ts` to optionally accept a polling bridge:

```ts
export class Scheduler {
  private pollingBridge?: PollingBridge;

  constructor(
    deps: SchedulerDeps,
    phase: SchedulerPhase,
    config: SchedulerConfig,
  ) {
    // In observer or active mode, start polling bridge
    if (phase !== "none") {
      this.pollingBridge = new PollingBridge(
        path.join(deps.dataDir, ".metadata", "recall_checkpoint.json"),
        {
          onL1Completed: (sk) => this.onL1Completed(sk),
          onSessionActivity: (sk) => this.notifyActivity(sk),
        },
      );
      this.pollingBridge.start();
    }
  }

  close(): void {
    this.pollingBridge?.close();
    // ...existing close logic
  }
}
```

- [ ] Wire polling bridge into scheduler
- [ ] Run tests — verify PASS

### Step 5: Add double-fire guards

In `src/services/scheduler.ts`:

```ts
private async evaluateAndDispatchL2(sessionKey: string): Promise<void> {
  // 1. Load memory_autonomy_state
  // 2. Check l2JobStatus — if "running" or "scheduled", log skip and return
  // 3. Evaluate triggers
  // 4. Atomically set l2JobStatus = "scheduled" in checkpoint
  // 5. Dispatch L2
  // 6. On completion: set l2JobStatus = "idle"

  const state = await this.checkpoint.getState(sessionKey);
  if (state.l2JobStatus !== "idle") {
    this.logger.info(
      `[scheduler] skip session=${sessionKey} job=L2 reason=already_running`,
    );
    return;
  }

  // ... trigger evaluation ...

  // Mark as scheduled atomically before dispatch
  await this.checkpoint.updateState(sessionKey, { l2JobStatus: "scheduled" });

  if (this.phase === "active") {
    try {
      await this.memoryPipeline.runL2(sessionKey);
      await this.checkpoint.updateState(sessionKey, {
        l2JobStatus: "idle",
        lastL2CompletedAt: new Date().toISOString(),
      });
    } catch (err) {
      await this.checkpoint.updateState(sessionKey, { l2JobStatus: "idle" });
      throw err;
    }
  }
}
```

- [ ] Implement atomic job status guards
- [ ] Run tests — verify PASS

---

## Task 3: Phase 3 — Full Migration (L2 + L3 ownership)

### Step 1: Define L2TriggerDelegate interface

The `L2TriggerDelegate` interface lives in `src/services/scheduler.ts` and is consumed by the vendor edit in `TencentDB-Agent-Memory/src/utils/pipeline-manager.ts`. It serves as the contract between the old pipeline manager and the new scheduler.

```ts
/**
 * One-time vendor edit interface to replace polling bridge.
 * Implemented by Scheduler, consumed by MemoryPipelineManager.
 * Location: `src/services/scheduler.ts` (define) → `TencentDB-Agent-Memory/src/utils/pipeline-manager.ts` (inject)
 */
export interface L2TriggerDelegate {
  onL1Completed(sessionKey: string): void;
  onSessionActivity(sessionKey: string): void;
  onShutdown(): Promise<void>;
}
```

Important: The interface is parameterized with `sessionKey` strings so the scheduler can map notifications to the correct checkpoint state.

- [ ] Add interface to `src/services/scheduler.ts`
- [ ] Document the one-directional nature (scheduler → pipeline, not bidirectional)
- [ ] Prepare the vendor PR with import + optional constructor param

### Step 2: Vendor PR to add L2TriggerDelegate callback

In `TencentDB-Agent-Memory/src/utils/pipeline-manager.ts`, add:

```ts
export interface L2TriggerDelegate {
  onL1Completed(sessionKey: string): void;
  onSessionActivity(sessionKey: string): void;
  onShutdown(): Promise<void>;
}

// In MemoryPipelineManager constructor:
constructor(
  // ...existing params...
  private readonly l2Delegate?: L2TriggerDelegate,
) {
  // ...existing init...
}

// In runL1(), after successful L1:
this.l2Delegate?.onL1Completed(sessionKey);

// In notifyConversation() (or equivalent):
this.l2Delegate?.onSessionActivity(sessionKey);

// In _doFlush():
await this.l2Delegate?.onShutdown();
```

- [ ] File vendor PR with the minimal change
- [ ] Wait for merge or apply as local patch (`scripts/apply-vendor-patch.ts`)

### Step 3: Replace polling bridge with direct callback

Once vendor edit is merged:

```ts
// In main.ts:
const scheduler = new Scheduler(deps, phase, config);
const memoryPipeline = new MemoryPipelineManager(
  // ...existing params...
  {  // L2TriggerDelegate
    onL1Completed: (sk) => scheduler.onL1Completed(sk),
    onSessionActivity: (sk) => scheduler.notifyActivity(sk),
    onShutdown: () => scheduler.close(),
  },
);
```

- [ ] Wire direct callback
- [ ] Remove polling bridge
- [ ] Run tests — verify PASS

### Step 4: Migrate remaining timers

| Timer | Move to scheduler |
|---|---|
| L1 idle timer | Stays in `MemoryPipelineManager` (tightly coupled to L0 recording) |
| L2 delay-after-L1 | Moved to scheduler's `onL1Completed` handler |
| L2 max interval polling | Moved to scheduler's recurring timer per active session |
| L2 force-after-idle | Scheduler only (new) |
| L2 startup recovery | Scheduler only (new) |
| L2 stale refresh | Scheduler only (new) |
| L3 persona | Dispatched by scheduler after L2 completion |
| Cold session cleanup | Scheduler's `coldSessionCleanupIntervalMs` |

- [ ] Implement all timer logic in scheduler
- [ ] Verify old scheduler's timers are effectively disabled
- [ ] Run tests — verify PASS

### Step 5: Add global concurrency limit

```ts
export class Scheduler {
  private runningJobs = 0;
  private jobQueue: Array<{ sessionKey: string; job: () => Promise<void> }> = [];

  private async enqueueJob(sessionKey: string, job: () => Promise<void>): Promise<void> {
    if (this.runningJobs >= this.config.globalConcurrencyLimit) {
      this.jobQueue.push({ sessionKey, job });
      this.logger.info(
        `[scheduler] queued session=${sessionKey} queue_depth=${this.jobQueue.length}`,
      );
      return;
    }

    this.runningJobs++;
    try {
      await job();
    } finally {
      this.runningJobs--;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (this.jobQueue.length > 0 && this.runningJobs < this.config.globalConcurrencyLimit) {
      const next = this.jobQueue.shift()!;
      this.enqueueJob(next.sessionKey, next.job);
    }
  }
}
```

- [ ] Implement global concurrency limiter
- [ ] Add queue depth logging
- [ ] Implement per-session single-job guarantee via checkpoint `l2JobStatus` / `personaJobStatus`

---

## Task 4: Add cold session cleanup

```ts
export class Scheduler {
  private coldCleanupTimer: ReturnType<typeof setInterval> | null = null;

  private startColdCleanupTimer(): void {
    this.coldCleanupTimer = setInterval(
      () => this.runColdCleanup(),
      this.config.coldSessionCleanupIntervalMs,
    );
  }

  private async runColdCleanup(): Promise<void> {
    const coldBefore = await this.checkpoint.getAllStates();
    let coldCount = 0;

    for (const [sessionKey, state] of Object.entries(coldBefore)) {
      const lastActive = new Date(state.sessionLastActiveAt).getTime();
      if (Date.now() - lastActive > this.config.coldSessionTimeoutMs) {
        await this.checkpoint.updateState(sessionKey, { sessionIsCold: true });
        this.inMemoryQueues.delete(sessionKey);
        coldCount++;
      }
    }

    if (coldCount > 0) {
      this.logger.info(
        `[scheduler] cleanup cold_sessions=${coldCount} remaining=${
          Object.keys(coldBefore).length - coldCount
        }`,
      );
    }
  }
}
```

- [ ] Implement cold session detection and cleanup
- [ ] Wire into scheduler lifecycle
- [ ] Run tests — verify PASS

---

## Timeline estimates

| Migration phase | Effort estimate | When to proceed |
|---|---|---|
| **Phase 1 (observer)** | 1–2 days | After Phase 0 checkpoint is merged and deployed. Safe to run alongside existing scheduler. |
| **Phase 2 (polling bridge)** | 3–5 days | After observer logs show accurate decisions for 1+ week in production. Must coordinate env config overrides to suppress old timers. |
| **Phase 3 (full migration)** | 3–5 days + vendor PR review | After polling bridge runs stably for 2+ weeks. Vendor PR must be merged or patched locally. |

Key milestone: The vendor `L2TriggerDelegate` PR is the gating dependency for Phase 3. Until it merges, the polling bridge is the permanent solution.

---

## Task 5: Rollback procedures

Document rollback steps for each phase:

| Phase | Rollback action |
|---|---|
| Observer | Set `MEMORY_SCHEDULER_PHASE=none`, restart |
| Partial (polling) | Restore `MEMORY_L2_DELAY_AFTER_L1` and `MEMORY_L2_MAX_INTERVAL` to original values. Disable all new catch-up feature gates. Restart. |
| Full (vendor edit) | Revert vendor edit. Use same rollback as Partial phase. |

- [ ] Document rollback procedures in `docs/ops/rollback-scheduler.md`

---

## Task 6: Verify scheduler migration

- [ ] Run focused tests:

```bash
bun test src/services/scheduler.test.ts src/services/polling-bridge.test.ts
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

- [ ] Manual verification (Phase 2): Start bot with `MEMORY_SCHEDULER_PHASE=active`, `MEMORY_L2_DELAY_AFTER_L1=604800`, `MEMORY_L2_MAX_INTERVAL=604800`. Send messages. Verify new scheduler dispatches L2, old scheduler's L2 timer does not fire.

---

## Self-review

- [ ] Observer mode is safe for production — logs only, never dispatches
- [ ] Polling bridge has configurable interval (default 2s) — acceptable latency for catch-up triggers
- [ ] Atomic job status guards prevent double-fire in all phases
- [ ] Vendor edit is minimal (3 callbacks, optional constructor param)
- [ ] Rollback is possible at any phase without data loss
- [ ] Timer registry is bounded, cleaned up on cold session and shutdown
- [ ] Global concurrency limit prevents resource exhaustion
- [ ] All scheduler actions logged per spec Section 14.6
