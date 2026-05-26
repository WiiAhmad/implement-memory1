# Phase 4: Offload Hardening — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offload more robust and bounded. Add wait-entry retry, MMD size guards, data retention reclaim, and status commands.

**Spec reference:** Sections 6.3, 6.5, 11 (Phase 4), 8.3

**Prerequisites:** Existing offload infrastructure (L1 tool pair capture, L3 compression). The offload module must already be functional.

---

## File structure

### Creates or modifies

- Modify: `src/offload/index.ts` — add wait-entry retry, MMD size guard, reclaim scheduling. Use `TencentDB-Agent-Memory/src/offload/backend-client.ts` for offload LLM calls during wait retry.
- Modify: `src/offload/types.ts` — add new config fields
- Create: `src/offload/reclaim.ts` — reclaim orchestrator wrapping `TencentDB-Agent-Memory/src/offload/reclaimer.ts`
- Create: `src/offload/reclaim.test.ts` — tests
- Modify: `src/config/env.ts` — add new offload env vars
- Modify: `src/config/env.test.ts` — assertions

---

## Task 1: Add offload hardening env vars

### Step 1: Write failing env tests

Add assertions for:
- `OFFLOAD_L2_WAIT_RETRY_SECONDS` defaults to 120
- `OFFLOAD_L2_TIME_TRIGGER_REQUIRES_NEW_OFFLOAD` defaults to true
- `OFFLOAD_LOG_MAX_SIZE_MB` defaults to 50
- `OFFLOAD_RECLAIM_ENABLED` defaults to false
- `OFFLOAD_L2_WAIT_RETRY_ENABLED` defaults to false

- [ ] Write test cases
- [ ] Run `bun test src/config/env.test.ts` — verify FAIL

### Step 2: Add to schema

Add to `EnvSchema`:

```ts
  OFFLOAD_L2_WAIT_RETRY_SECONDS: z.coerce.number().int().positive().default(120),
  OFFLOAD_L2_TIME_TRIGGER_REQUIRES_NEW_OFFLOAD: boolString.default("true"),
  OFFLOAD_LOG_MAX_SIZE_MB: z.coerce.number().int().positive().default(50),
```

These vars were already declared as feature gates in Phase 0:
```ts
  OFFLOAD_RECLAIM_ENABLED: boolString.default("false"),
  OFFLOAD_L2_WAIT_RETRY_ENABLED: boolString.default("false"),
```

- [ ] Implement schema additions
- [ ] Run `bun test src/config/env.test.ts` — verify PASS

---

## Task 2: Implement wait-entry retry

### Step 1: Write failing tests

Add to `src/offload/index.test.ts`:

```ts
describe("wait-entry retry", () => {
  test("retries entries with node_id=wait after wait-retry timeout", async () => {
    // Mock offload entries with some marked "wait"
    // Set OFFLOAD_L2_WAIT_RETRY_ENABLED=true
    // Run L2 trigger
    // Verify wait entries are retried
  });

  test("skips wait retry when feature gate disabled", async () => {
    // Same setup but OFFLOAD_L2_WAIT_RETRY_ENABLED=false
    // Verify wait entries NOT retried
  });

  test("does not retry wait entries before timeout elapses", async () => {
    // Set waitRetrySeconds = 120
    // Execute at t=0, then at t=60
    // Verify retry does not happen at t=60
  });

  test("backfills node_ids after successful retry", async () => {
    // Mock successful L2 after retry
    // Verify node_ids are updated in storage
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/offload/index.test.ts` — verify FAIL

### Step 2: Implement wait-entry retry

In `src/offload/index.ts`, modify the L2 trigger logic:

```ts
private async evaluateL2Trigger(sessionKey: string): Promise<void> {
  const entries = await readAllOffloadEntries(sessionCtx);
  const nullEntries = entries.filter(e => e.node_id === null);
  const waitEntries = entries.filter(e => e.node_id === "wait");

  // Null threshold trigger
  if (nullEntries.length >= this.config.l2NullThreshold) {
    return this.runL2(sessionKey, "null_threshold");
  }

  // Wait retry trigger (only if enabled)
  if (this.config.l2WaitRetryEnabled && waitEntries.length > 0) {
    const oldestWait = waitEntries[0];
    const waitAge = Date.now() - new Date(oldestWait.timestamp).getTime();
    if (waitAge >= this.config.l2WaitRetrySeconds * 1000) {
      return this.runL2(sessionKey, "wait_retry");
    }
  }

  // Timeout trigger
  if (this.config.timeTriggerRequiresNewOffload) {
    // Only trigger if there are null entries AND timeout elapsed
    if (nullEntries.length > 0) {
      // Check timeout
    }
  }
}
```

- [ ] Implement wait-entry detection and retry scheduling
- [ ] Use `BackendClient` from `TencentDB-Agent-Memory/src/offload/backend-client.ts` for re-mapping wait entries (call the offload LLM with the same tool/result pair but with updated context)
- [ ] Integrate into L2 trigger evaluation
- [ ] Run `bun test src/offload/index.test.ts` — verify PASS

---

## Task 3: Implement MMD size guard

### Step 1: Write failing tests

Add to `src/offload/index.test.ts`:

```ts
describe("MMD size guard", () => {
  test("truncates MMD when it exceeds token budget", async () => {
    // Mock MMD content exceeding mmdMaxTokenRatio of context window
    // Verify MMD is truncated to fit
  });

  test("prefers current active MMD over old MMDs", async () => {
    // Multiple MMD files exist
    // Verify current active MMD is preferred for injection
  });
});
```

- [ ] Write test cases
- [ ] Verify FAIL

### Step 2: Implement guard

In `src/offload/index.ts`:

```ts
private async guardMmdSize(sessionKey: string): Promise<void> {
  const ctx = createStorageContext(this.dataDir, sessionKey);
  const activeMmd = await readMmd(ctx, "active");

  if (!activeMmd) return;

  const tokenCount = estimateTokens(activeMmd.content);
  const maxTokens = Math.floor(
    this.config.contextWindow * this.config.mmdMaxTokenRatio,
  );

  if (tokenCount > maxTokens) {
    // Truncate MMD to fit within budget
    const truncated = this.truncateMmd(activeMmd.content, maxTokens);
    await writeMmd(ctx, "active", truncated);

    this.logger.info(
      `[offload] MMD truncated session=${sessionKey} ` +
      `before=${tokenCount} after=${estimateTokens(truncated)}`,
    );
  }
}
```

- [ ] Implement size guard with token estimation
- [ ] Integrate into `beforeTurn()` before MMD injection
- [ ] Run tests — verify PASS

---

## Task 4: Implement data retention reclaim

### Step 1: Write failing tests

Create `src/offload/reclaim.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

describe("offload reclaim", () => {
  test("deletes offload data older than retention window", async () => {
    // Create temp dir with old and new offload files
    // Run reclaim with retentionDays=3
    // Verify old files deleted, new files intact
  });

  test("preserves active MMD", async () => {
    // Active MMD is within retention window
    // Verify it is NOT deleted
  });

  test("skips reclaim when feature gate disabled", async () => {
    // OFFLOAD_RECLAIM_ENABLED=false
    // Verify no files deleted
  });

  test("logs reclaim stats", async () => {
    // Run reclaim with known file set
    // Verify log contains jsonl=N refs=N mmds=N logs=N
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/offload/reclaim.test.ts` — verify FAIL

### Step 2: Implement reclaim orchestrator

Create `src/offload/reclaim.ts`:

```ts
import { reclaimOffloadData } from "../../TencentDB-Agent-Memory/src/offload/reclaimer.ts";

export interface ReclaimConfig {
  retentionDays: number;
  logMaxSizeMb: number;
  enabled: boolean;
}

export interface ReclaimStats {
  deletedJsonl: number;
  deletedRefs: number;
  deletedMmds: number;
  deletedLogs: number;
  errors: string[];
}

export class OffloadReclaimService {
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly config: ReclaimConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.enabled || this.config.retentionDays < 1) return;

    // Run immediately on start, then every 24h
    this.runReclaim();
    this.reclaimTimer = setInterval(() => this.runReclaim(), 24 * 60 * 60 * 1000);
  }

  async runReclaim(): Promise<ReclaimStats> {
    // Call library's reclaimOffloadData()
    // Log stats
  }

  close(): void {
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
  }
}
```

- [ ] Implement reclaim orchestrator
- [ ] Wire into `OffloadService` lifecycle
- [ ] Run `bun test src/offload/reclaim.test.ts` — verify PASS

### Step 3: Add `/offload-reclaim` admin command

In `src/telegram/admin-handlers.ts`:

- [ ] Add `/offload-reclaim` handler
- [ ] Require --confirm flag for destructive action
- [ ] Log invocation per Section 10.5
- [ ] Run reclaim and return stats summary

---

## Task 5: Verify Phase 4 together

- [ ] Run focused tests:

```bash
bun test src/offload/ src/config/env.test.ts
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

- [ ] Manual: verify old offload files are cleaned up when reclaim enabled

---

## Self-review

- [ ] Wait-entry retry respects `OFFLOAD_L2_WAIT_RETRY_SECONDS` and feature gate
- [ ] MMD size guard uses token estimation, not character count
- [ ] Reclaim preserves active MMD while deleting old JSONL/ref/MMD files
- [ ] Reclaim logs stats per spec Section 9.2
- [ ] All new behavior gated by feature flags (default off)
- [ ] No vendor edits required — all changes in root `src/offload/`
