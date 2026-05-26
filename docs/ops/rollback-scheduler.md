# Scheduler Migration — Rollback Procedures

> **Documentation:** Rollback steps for the scheduler migration (Phases 1–3).
> **Spec reference:** Sections 14.1–14.7, Phase 5 Task 5

## Overview

The scheduler migration replaces the TDAI engine's internal L2/L3 scheduling with the new global `Scheduler`. Rollback is possible at any phase without data loss.

---

## Phase 1: Observer Mode — No Behavioral Change

Observer mode only logs decisions; it never dispatches. Rollback is trivial:

```bash
# 1. Set scheduler to disabled
export MEMORY_SCHEDULER_PHASE=none

# 2. Ensure all new catch-up feature gates are disabled
export MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=false
export MEMORY_L2_STARTUP_RECOVERY_ENABLED=false
export MEMORY_L2_STALE_REFRESH_ENABLED=false
export MEMORY_PERSONA_STALE_REFRESH_ENABLED=false
export MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED=false

# 3. Restart the bot
```

**Impact:** Zero. The scheduler runs no code. Old `MemoryPipelineManager` timers resume original behavior.

---

## Phase 2: Polling Bridge (Partial Migration)

The polling bridge reads checkpoint state to drive the new scheduler's L2 triggers. The old scheduler's L2 timers are disabled indirectly via large interval overrides. To roll back:

### Step 1: Disable the new scheduler

```bash
export MEMORY_SCHEDULER_PHASE=none
```

### Step 2: Restore the old scheduler's L2 timer values

```bash
# Restore original TDAI L2 timing (pre-migration defaults)
export MEMORY_L2_DELAY_AFTER_L1=5        # was 604800 (7 days) during migration
export MEMORY_L2_MAX_INTERVAL=3600       # was 604800 (7 days) during migration
```

### Step 3: Disable all new catch-up feature gates

```bash
export MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=false
export MEMORY_L2_STARTUP_RECOVERY_ENABLED=false
export MEMORY_L2_STALE_REFRESH_ENABLED=false
export MEMORY_PERSONA_STALE_REFRESH_ENABLED=false
export MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED=false
export OFFLOAD_RECLAIM_ENABLED=false
export OFFLOAD_L2_WAIT_RETRY_ENABLED=false
```

### Step 4: Restart the bot

```bash
# The old MemoryPipelineManager's L2 timers resume original behavior.
# The polling bridge stops because scheduler is in "none" phase.
```

**Data safety:** Checkpoint state (`memory_autonomy_state` namespace) is preserved but ignored during rollback. When re-enabled, it resumes from the preserved state.

---

## Phase 3: Full Migration (Vendor Edit)

If a vendor edit was applied to `TencentDB-Agent-Memory/` to add the `L2TriggerDelegate` callback:

### Step 1: Revert the vendor edit

```bash
cd TencentDB-Agent-Memory
git checkout -- src/utils/pipeline-manager.ts
```

Or restore the submodule to the committed version:

```bash
git submodule update --recursive TencentDB-Agent-Memory
```

### Step 2: Same as Phase 2 rollback

Apply all Phase 2 rollback steps (disable scheduler, restore old timer values, disable feature gates).

### Step 3: Rebuild and restart

```bash
bun run build
# Then restart the bot
```

---

## Rollback Verification

After rollback, verify:

1. **Bot starts without errors**: Check startup logs for `[scheduler]` messages indicating "none" phase.
2. **Old scheduler L2 timers resume**: Send messages and verify L2 scene extraction runs at the expected intervals (check logs for `[memory-tdai]` L2 extraction events).
3. **No double-fire**: Verify L2 does not run twice (check for duplicate `[memory-tdai]` events with same content).
4. **Memory checkpoint preserved**: Verify `data/memory-tdai/.metadata/recall_checkpoint.json` still contains the `memory_autonomy_state` namespace (read-only during rollback).

---

## Migration Status Tracking

| Phase | Status | Date | Notes |
|---|---|---|---|
| Phase 0 (checkpoint) | Done | | `memory_autonomy_state` namespace deployed |
| Phase 1 (observer) | Done | | Scheduler logs-only since Phase 2 deployment |
| Phase 2 (polling bridge) | Current | | Polling bridge + global concurrency limit active |
| Phase 3 (full migration) | Planned | | Requires vendor PR for `L2TriggerDelegate` |

---

## Troubleshooting

### Symptom: L2 runs twice per trigger

1. Check `l2JobStatus` in checkpoint — should show `"idle"` between runs.
2. Check polling bridge vs old timer overlap — ensure `MEMORY_L2_DELAY_AFTER_L1` and `MEMORY_L2_MAX_INTERVAL` are set to large values.
3. If both schedulers fire, the `SerialQueue` in TDAI prevents concurrent L2; the second run is a no-op.

### Symptom: L2 never runs in active mode

1. Verify `MEMORY_SCHEDULER_PHASE=active`.
2. Verify polling bridge detects changes: check logs for `[scheduler] L1_completed` messages.
3. Verify checkpoint file exists and has `pipeline_states` entries.
4. Verify trigger conditions are met (pending work, interval elapsed, etc.).

### Symptom: Scheduler errors on startup

1. Check `data/memory-tdai/.metadata/recall_checkpoint.json` exists and is valid JSON.
2. Set `MEMORY_AUTONOMY_CHECKPOINT_FILE_LOCK_ENABLED=false` for debugging.
3. Set `MEMORY_SCHEDULER_PHASE=none` and restart — if clean, the issue is scheduler config or checkpoint format.
