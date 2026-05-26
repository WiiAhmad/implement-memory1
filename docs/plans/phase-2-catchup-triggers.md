# Phase 2: TDAI Catch-Up Triggers — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent L2 and persona starvation for low-volume users. Add force-after-idle, startup recovery, stale refresh, and persona missing/stale fallback triggers.

**Spec reference:** Sections 5.2, 5.4, 8.1, 11 (Phase 2), 14.7.2 (observer mode)

**Prerequisites:** Phase 0 (checkpoint integration exists with `MemoryAutonomyCheckpoint`), Phase 1 (logging infrastructure)

---

## File structure

### Creates or modifies

- Create: `src/services/scheduler.ts` — new global scheduler with catch-up triggers
- Create: `src/services/scheduler.test.ts` — unit tests for trigger decisions
- Modify: `src/offload/index.ts` — offload side remains unchanged
- Modify: `src/agent/context-agent.ts` — notify scheduler on user activity
- Modify: `src/services/chat-service.ts` — pass activity notifications
- Modify: `src/main.ts` — wire scheduler into lifecycle

---

## Task 1: Add new env vars for catch-up triggers

### Step 1: Write failing env tests

Add assertions for:
- `MEMORY_L2_FORCE_AFTER_IDLE_SECONDS` defaults to 900
- `MEMORY_L2_STARTUP_RECOVERY_DELAY_SECONDS` defaults to 30
- `MEMORY_L2_STALE_REFRESH_HOURS` defaults to 24
- `MEMORY_L2_MIN_INTERVAL` stays at 600
- `MEMORY_PERSONA_MAX_STALE_HOURS` defaults to 24
- `MEMORY_PERSONA_MIN_SCENES` defaults to 1
- `MEMORY_PERSONA_MIN_CHANGED_SCENES` defaults to 1
- `MEMORY_PERSONA_FORCE_IF_MISSING` defaults to true (env var or computed from feature gate)

- [ ] Write test cases
- [ ] Run `bun test src/config/env.test.ts` — verify FAIL

### Step 2: Add to schema

Add to `EnvSchema`:

```ts
  MEMORY_L2_FORCE_AFTER_IDLE_SECONDS: z.coerce.number().int().positive().default(900),
  MEMORY_L2_STARTUP_RECOVERY_DELAY_SECONDS: z.coerce.number().int().min(0).default(30),
  MEMORY_L2_STALE_REFRESH_HOURS: z.coerce.number().int().positive().default(24),
  MEMORY_PERSONA_MAX_STALE_HOURS: z.coerce.number().int().positive().default(24),
  MEMORY_PERSONA_MIN_SCENES: z.coerce.number().int().min(1).default(1),
  MEMORY_PERSONA_MIN_CHANGED_SCENES: z.coerce.number().int().min(1).default(1),
```

Add to `AppEnv`:

```ts
  memory: {
    l2ForceAfterIdleSeconds: parsed.MEMORY_L2_FORCE_AFTER_IDLE_SECONDS,
    l2StartupRecoveryDelaySeconds: parsed.MEMORY_L2_STARTUP_RECOVERY_DELAY_SECONDS,
    l2StaleRefreshHours: parsed.MEMORY_L2_STALE_REFRESH_HOURS,
    personaMaxStaleHours: parsed.MEMORY_PERSONA_MAX_STALE_HOURS,
    personaMinScenes: parsed.MEMORY_PERSONA_MIN_SCENES,
    personaMinChangedScenes: parsed.MEMORY_PERSONA_MIN_CHANGED_SCENES,
    // existing fields carried forward
  },
```

- [ ] Implement schema additions
- [ ] Run `bun test src/config/env.test.ts` — verify PASS

---

## Task 2: Implement scheduler with trigger logic

### Step 1: Write failing tests

Create `src/services/scheduler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Scheduler, type SchedulerDeps } from "./scheduler.ts";

function makeDeps(overrides?: Partial<SchedulerDeps>): SchedulerDeps {
  return {
    autnomyCheckpoint: { getState: async () => ({ ... }) } as any,
    memoryPipeline: { runL2: async () => {}, runPersona: async () => {} } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    config: {
      l2ForceAfterIdleSeconds: 900,
      l2StartupRecoveryDelaySeconds: 30,
      l2StaleRefreshHours: 24,
      l2MinInterval: 600,
      l2MaxInterval: 1800,
      personaMaxStaleHours: 24,
      personaMinScenes: 1,
      personaMinChangedScenes: 1,
      personaTriggerN: 20,
      sessionWindowHours: 24,
      checkpointNamespace: "memory_autonomy_state",
      checkpointFileLockEnabled: true,
      globalConcurrencyLimit: 3,
      coldSessionCleanupIntervalMs: 600_000,
      coldSessionTimeoutMs: 3_600_000,
      // Feature gates from Phase 0 MemoryAutonomyConfig
      featureGates: {
        l2ForceAfterIdle: true,
        l2StartupRecovery: false,
        l2StaleRefresh: false,
        personaStaleRefresh: true,
        personaForceIfMissing: true,
        sceneArchive: false,
        sceneMerge: false,
        offloadReclaim: false,
        offloadL2WaitRetry: false,
      },
    },
    ...overrides,
  };
}

describe("Scheduler trigger decisions", () => {
  test("force-after-idle: runs when pending work exists and idle time elapsed", async () => {
    // Setup: lastL1CompletedAt = 1000s ago, lastL2CompletedAt = 2000s ago
    // l2ForceAfterIdleSeconds = 900
    // pending_l1_count > 0
    // Expected: should trigger L2
  });

  test("force-after-idle: skipped when feature gate disabled", async () => {
    // Same setup but featureGates.l2ForceAfterIdle = false
    // Expected: should NOT trigger, log skip reason
  });

  test("force-after-idle: skipped when no pending work", async () => {
    // pending_l1_count = 0
    // Expected: should NOT trigger
  });

  test("force-after-idle: skipped within idle window", async () => {
    // lastL1CompletedAt = 100s ago
    // l2ForceAfterIdleSeconds = 900
    // Expected: should NOT trigger
  });

  test("startup recovery: runs at boot when checkpoint has pending work", async () => {
    // lastMemorySeqExtracted = 10, lastMemorySeqProcessedByL2 = 5
    // startup recovery enabled
    // Expected: should schedule L2 after delay
  });

  test("startup recovery: skipped when no pending work", async () => {
    // lastMemorySeqExtracted = 10, lastMemorySeqProcessedByL2 = 10
    // Expected: should NOT schedule
  });

  test("stale refresh: runs when scene index old and session active", async () => {
    // sceneIndexUpdatedAt = 48 hours ago, MEMORY_L2_STALE_REFRESH_HOURS = 24
    // sessionIsCold = false
    // Expected: should trigger L2 in maintenance mode
  });

  test("stale refresh: skipped for cold sessions", async () => {
    // sceneIndexUpdatedAt old but sessionIsCold = true
    // Expected: should skip
  });

  test("L2 skipped when min interval not elapsed", async () => {
    // lastL2CompletedAt = 100s ago, MEMORY_L2_MIN_INTERVAL = 600
    // Expected: skip (unless forced)
  });

  test("L2 skipped when already running", async () => {
    // l2JobStatus = "running"
    // Expected: skip
  });

  test("persona: triggers when missing and scenes exist", async () => {
    // lastPersonaAt = null, sceneCount >= 1
    // featureGates.personaForceIfMissing = true
    // Expected: trigger persona
  });

  test("persona: triggers when stale and changed scenes exist", async () => {
    // lastPersonaAt = 48 hours ago, MEMORY_PERSONA_MAX_STALE_HOURS = 24
    // lastSceneSeqProcessedByPersona < lastSceneSeqExtracted
    // Expected: trigger persona
  });

  test("persona: skipped when no scenes", async () => {
    // sceneCount = 0
    // Expected: skip
  });

  test("persona: skipped when recently generated and no changes", async () => {
    // lastPersonaAt = 1 hour ago, MEMORY_PERSONA_MAX_STALE_HOURS = 24
    // lastSceneSeqProcessedByPersona >= lastSceneSeqExtracted
    // Expected: skip
  });
});
```

- [ ] Write all test cases
- [ ] Run `bun test src/services/scheduler.test.ts` — verify FAIL

### Step 2: Implement scheduler

Create `src/services/scheduler.ts`:

```ts
export interface SchedulerConfig {
  l2ForceAfterIdleSeconds: number;
  l2StartupRecoveryDelaySeconds: number;
  l2StaleRefreshHours: number;
  l2MinInterval: number;
  l2MaxInterval: number;
  personaMaxStaleHours: number;
  personaMinScenes: number;
  personaMinChangedScenes: number;
  personaTriggerN: number;
  sessionWindowHours: number;
  featureGates: FeatureGates;
}

export interface SchedulerDeps {
  autonomyCheckpoint: MemoryAutonomyCheckpoint;
  memoryPipeline: {
    runL2(sessionKey: string): Promise<void>;
    runPersona(sessionKey: string): Promise<void>;
    getStatus(): Promise<{
      sessionKeys: string[];
      pendingL1Count: number;
      sceneCount: number;
    }>;
  };
  logger: Logger;
  config: SchedulerConfig;
}

export class Scheduler {
  // Phase: "observer" | "active"
  // In observer mode: evaluate and log only, never dispatch
  // In active mode: evaluate and dispatch jobs

  constructor(private readonly deps: SchedulerDeps, private readonly phase: "none" | "observer" | "active") {}

  async notifyActivity(sessionKey: string): Promise<void> {
    // Called on every user message
    // Update sessionLastActiveAt in checkpoint
    // Reset idle timer
  }

  async onL1Completed(sessionKey: string): Promise<void> {
    // Called when L1 extraction finishes
    // Update sequencing counters in checkpoint
    // Evaluate whether to dispatch L2
  }

  async evaluateAndDispatchL2(sessionKey: string): Promise<void> {
    // Core trigger decision logic:
    // 1. Load checkpoint state
    // 2. Check each trigger condition in priority order:
    //    a. Force-after-idle (if enabled AND time elapsed AND pending work)
    //    b. Low-volume first scene (if meaningful memory exists AND no scenes)
    //    c. Stale refresh (if enabled AND scene index stale AND session active)
    //    d. Startup recovery (if enabled AND pending work AND just booted)
    //    e. Standard delay-after-L1 (if pending work AND delay elapsed)
    // 3. Check skip conditions:
    //    - No pending work → skip with reason
    //    - Min interval not elapsed → skip with reason
    //    - L2 already running → skip with reason
    //    - Cold session (periodic maintenance only) → skip with reason
    // 4. Log decision
    // 5. If active phase: dispatch L2, update checkpoint atomically
  }

  async evaluateAndDispatchPersona(sessionKey: string): Promise<void> {
    // Core persona trigger decision logic:
    // 1. Load checkpoint state
    // 2. Check each trigger condition:
    //    a. Missing persona (if enabled AND no persona AND scenes exist)
    //    b. Empty persona body (if enabled AND empty body AND scenes exist)
    //    c. First scene exists (if new scene AND memories since last persona)
    //    d. Threshold reached (if memories >= trigger N)
    //    e. Stale (if age >= maxStaleHours AND changed scenes)
    // 3. Check skip conditions
    // 4. Log decision
    // 5. If active phase: dispatch persona, update checkpoint
  }

  async scheduleStartupRecovery(): Promise<void> {
    // On boot: read checkpoint for all sessions
    // For each session with pending L2 work:
    //   Skip if feature gate disabled
    //   Schedule L2 after startup recovery delay
  }

  async scheduleStaleRefreshTimer(): Promise<void> {
    // Set interval timer to check stale sessions
  }

  async close(): Promise<void> {
    // Clear all timers
    // Save checkpoint state
  }
}
```

Trigger decision logic (from spec):

```text
Run L2 if:
  pending_l1_count > 0 and delay_after_l1 elapsed
  OR pending_l1_count > 0 and force_after_idle elapsed
  OR first meaningful memory exists and no scene exists
  OR scene index is stale and session active
  OR shutdown flush

Skip L2 if:
  no pending_work
  OR no L1 memories and no useful conversation data
  OR min interval has not elapsed (unless forced)
  OR another L2 for same session is running
  OR session is cold and this is only periodic maintenance
```

- [ ] Implement `Scheduler` class with all trigger decision methods
- [ ] Implement observer mode (log only, no dispatch)
- [ ] Implement active mode (log + dispatch)
- [ ] Run `bun test src/services/scheduler.test.ts` — verify PASS

---

## Task 3: Wire scheduler into lifecycle

### Step 1: Add activity notification path

Modify `src/services/chat-service.ts` to call `scheduler.notifyActivity()` on every user message.

- [ ] Add optional `scheduler` parameter to `ChatService`
- [ ] Call `scheduler.notifyActivity(sessionKey)` in `replyToUser()`
- [ ] Run `bun test src/services/chat-service.test.ts` — verify PASS

### Step 2: Wire at boot

Modify `src/main.ts`:

- [ ] Instantiate `Scheduler` with `SchedulerConfig` from env
- [ ] Pass to `ChatService` constructor
- [ ] Call `scheduler.scheduleStartupRecovery()` after memory pipeline init
- [ ] Call `scheduler.close()` during shutdown

### Step 3: Observer mode default

Set `MEMORY_SCHEDULER_PHASE=none` as default in env — no code runs.
Set to `observer` for Phase 2 evaluation — logs only, no dispatch.

- [ ] Verify bot starts with all three phase values
- [ ] Verify `observer` phase produces `[scheduler] [observer]` log lines without dispatching
- [ ] Run full test suite — verify PASS

---

## Task 4: Verify Phase 2 together

- [ ] Run focused tests:

```bash
bun test src/config/env.test.ts src/services/scheduler.test.ts src/services/chat-service.test.ts
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

- [ ] Manual verification (observer mode): Start bot with `MEMORY_SCHEDULER_PHASE=observer`, send messages, verify `[scheduler] [observer]` log lines appear describing what triggers *would* fire.

---

## Self-review

- [ ] All trigger conditions match spec Section 5.2 and 5.4 exactly
- [ ] Observer mode logs but never dispatches — safe for production
- [ ] Job status guards (`l2JobStatus`, `personaJobStatus`) prevent concurrent runs
- [ ] Sequencing counters enable deterministic skip detection
- [ ] Feature gates can disable any trigger independently
- [ ] All trigger/skip decisions produce logged reasons per spec Section 9.1
