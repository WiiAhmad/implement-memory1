# Phase 1: Visibility and Safe Config — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add detailed skip/run reason logs for all pipeline layers, and add `/memory-status` and `/offload-status` admin commands. No behavioral changes.

**Spec reference:** Sections 9, 10, 11 (Phase 1)

**Prerequisites:** Phase 0 (checkpoint integration for state reading)

---

## File structure

### Creates or modifies

- Create: `src/telegram/admin-handlers.ts` — `/memory-status`, `/offload-status` command handlers
- Create: `src/telegram/admin-handlers.test.ts` — tests for status output formatting and redaction
- Modify: `src/telegram/bot.ts` — register admin commands
- Modify: `src/offload/index.ts` — add detailed logs for L1/L1.5/L2/L3 skip/run reasons
- Modify: `src/memory/tencent-memory-adapter.ts` — add detailed logs for L2/L3 skip/run reasons
- Modify: `src/config/env.ts` — add `ADMIN_USER_IDS`, `SUPER_ADMIN_USER_ID` env vars
- Modify: `src/config/env.test.ts` — assertions for new vars
- Modify: `.env.example` — document admin config

---

## Task 1: Add admin identity env vars

### Step 1: Write failing env tests

Add to `src/config/env.test.ts` assertions for:
- `ADMIN_USER_IDS` defaults to empty array
- `SUPER_ADMIN_USER_ID` defaults to undefined

- [ ] Write test case
- [ ] Run `bun test src/config/env.test.ts` — verify FAIL

### Step 2: Add to schema

Add to `EnvSchema`:

```ts
  ADMIN_USER_IDS: z.string().default("").transform((v) =>
    v.split(",").map((s) => s.trim()).filter(Boolean).map(Number)
  ).pipe(z.array(z.number().int().positive())),
  SUPER_ADMIN_USER_ID: z.coerce.number().int().positive().optional(),
```

Add to `AppEnv`:

```ts
  admin: {
    userIds: parsed.ADMIN_USER_IDS,
    superAdminUserId: parsed.SUPER_ADMIN_USER_ID,
  },
```

- [ ] Implement schema additions
- [ ] Run `bun test src/config/env.test.ts` — verify PASS

### Step 3: Document in `.env.example`

```dotenv
# ── Admin Identity ──────────────────────────────────────────────────────────
ADMIN_USER_IDS=
SUPER_ADMIN_USER_ID=
```

- [ ] Append to `.env.example`

---

## Task 2: Add detailed pipeline logs

### Step 1: Add TDAI L2/L3 skip/run reason logs

In `src/memory/tencent-memory-adapter.ts`, add logging at every decision point:

- **L2 scheduled**: Log reason `after_l1 | force_idle | startup_recovery | stale_refresh | shutdown`
- **L2 skipped**: Log reason `no_pending_work | min_interval | cold_session | already_running`
- **L3 persona trigger**: Log reason `missing | empty | first_scene | threshold | stale | explicit`
- **L3 persona skipped**: Log reason `no_scenes | fresh | no_changed_scenes | already_running`

Format: `[memory-tdai] [pipeline] L2 scheduled reason=<reason> session=<key>`

- [ ] Add L2 run/skip logs at each exit point in the L2 trigger chain
- [ ] Add L3 run/skip logs at each exit point in the persona trigger chain
- [ ] Run `bun test src/memory/tencent-memory-adapter.test.ts` — verify PASS

### Step 2: Add offload L1/L1.5/L2/L3 skip/run reason logs

In `src/offload/index.ts`, add logging at every decision point:

- **L1 flush**: Log reason `threshold | after_turn | shutdown`, pending count, entries count, fallback flag
- **L1.5 judge**: Log result `continue | new_task | short | long`, retry count
- **L2 scheduled**: Log reason `null_threshold | timeout | wait_retry`
- **L2 skipped**: Log reason `no_entries | disabled | already_running | no_model`
- **L3 compression**: Log tokens before/after, tier applied

- [ ] Add offload L1 logs at flush points
- [ ] Add offload L1.5 logs at judgment points
- [ ] Add offload L2 logs at schedule/skip points
- [ ] Add offload L3 compression logs
- [ ] Run `bun test src/offload/` — verify PASS

---

## Task 3: Implement `/memory-status` command

### Step 1: Write failing tests

Create `src/telegram/admin-handlers.test.ts`:

```ts
describe("memoryStatus handler", () => {
  test("returns formatted memory status", async () => {
    // Mock MemoryAutonomyCheckpoint with known state
    // Mock MemoryPipelineManager.getStatus() with known counts
    // Verify output contains all required fields
  });

  test("redacts raw message content", async () => {
    // Verify that memory content is not included in output
  });

  test("shows checkpoint fields", async () => {
    // Verify seq counters, job status, sessionIsCold are present
  });
});
```

- [ ] Write test cases for memory status formatting
- [ ] Write test cases for redaction rules
- [ ] Run `bun test src/telegram/admin-handlers.test.ts` — verify FAIL

### Step 2: Implement handler

Create `src/telegram/admin-handlers.ts`:

```ts
import { Context } from "grammy";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { MemoryAutonomyCheckpoint, MemoryCheckpointState } from "../memory/autonomy-checkpoint.ts";
import type { OffloadService } from "../offload/index.ts";

interface AdminDeps {
  logger: Logger;
  isAdmin: (userId: number) => boolean;
  isSuperAdmin: (userId: number) => boolean;
  memoryCheckpoint: MemoryAutonomyCheckpoint;
  offloadService?: OffloadService;
}

export function registerAdminHandlers(
  bot: Bot,
  deps: AdminDeps,
): void {
  // /memory-status — show memory pipeline state
  bot.command("memory-status", async (ctx: Context) => {
    if (!deps.isAdmin(ctx.from?.id ?? 0)) {
      await ctx.reply("Access denied.");
      return;
    }
    // ...
  });
}
```

Required output format:

```text
Memory:
- L1 buffered messages: N
- L1 pending conversations: N
- Last L1: timestamp or "never"
- Last L2: timestamp or "never"
- L2 seq processed: N / L1 seq extracted: N
- Scene count: active=N stale=N archived=N
- Scene index updated: timestamp or "never"
- Persona updated: timestamp or "never"
- Persona stale: yes/no
- Persona age: N hours or "N/A"
- L2 job status: idle|running|scheduled
- Last meaningful memory: timestamp or "never"

Checkpoint:
- pending_l1_count: N
- lastMemorySeqProcessedByL2: N
- lastSceneSeqProcessedByPersona: N
- sessionIsCold: yes/no
```

- [ ] Implement admin identity checks
- [ ] Implement `/memory-status` handler reading from `MemoryAutonomyCheckpoint`
- [ ] Implement redaction logic
- [ ] Run `bun test src/telegram/admin-handlers.test.ts` — verify PASS

---

## Task 4: Implement `/offload-status` command

### Step 1: Write failing tests

Add to `admin-handlers.test.ts`:

```ts
describe("offloadStatus handler", () => {
  test("returns formatted offload status with counts", async () => {
    // Mock OffloadService status
    // Verify output contains enabled/disabled, entries, MMD info
  });
});
```

- [ ] Write test case
- [ ] Verify FAIL

### Step 2: Implement handler

Add to `src/telegram/admin-handlers.ts`:

Required output format:

```text
Offload:
- Enabled: yes/no
- Pending tool pairs: N
- Offload entries: N
- Null node entries: N
- Active MMD: filename or "none"
- Last L2: timestamp or "never"
- L3 compression last saved tokens: N
```

- [ ] Implement `/offload-status` handler
- [ ] Run `bun test src/telegram/admin-handlers.test.ts` — verify PASS

### Step 3: Wire into bot

Modify `src/telegram/bot.ts` to call `registerAdminHandlers()` after auth middleware.

- [ ] Import and call `registerAdminHandlers` in bot setup
- [ ] Run full suite to verify no regressions

---

## Task 5: Document current env values

- [ ] Scan `src/config/env.ts` and document all memory/offload env vars with current defaults in a README or inline comment
- [ ] Cross-reference with `.env.example` to ensure all vars are listed

---

## Task 6: Verify Phase 1 together

- [ ] Run focused tests:

```bash
bun test src/config/env.test.ts src/memory/ src/offload/ src/telegram/admin-handlers.test.ts
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

- [ ] Manual verification: Start bot with `ADMIN_USER_IDS` set, send `/memory-status`, verify output format matches spec

---

## Self-review

- [ ] No behavioral changes — only logs added, no new triggers dispatch
- [ ] All logs use consistent `[memory-tdai]` / `[offload]` / `[scheduler]` prefixes
- [ ] Admin identity is checked on every command invocation
- [ ] Status output redacts raw content per spec Section 10.2
- [ ] All new env vars have Zod defaults and are documented in `.env.example`
