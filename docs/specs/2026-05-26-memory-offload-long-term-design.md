# Memory and Offload Long-Term Autonomy Design

## Status

Draft v1, 2026-05-26

## 1. Purpose

This spec defines how the Telegram bot should manage long-term memory and context offload over many days of usage, many user sessions, and many tracked scenes.

The main goal is to prevent two failure modes:

1. Long-term memory starvation: L2 scene extraction or L3 persona generation does not run for a long time because threshold requirements are not reached.
2. Long-term memory pollution: too many scenes, stale scenes, duplicated scenes, or low-value memories reduce recall quality.

The design separates two systems that are currently both present in the codebase:

1. TDAI memory: user memory, scene memory, persona memory.
2. Offload: context compression, tool-result summarization, task MMDs, skill generation.

They are complementary. Offload protects the prompt/context window. TDAI memory preserves long-term user understanding.

## 2. System Boundary

### 2.1 TDAI Memory

TDAI memory is the user memory system.

| Layer | Name | Purpose | Existing Trigger |
|---|---|---|---|
| L0 | Conversation capture | Stores raw user/assistant turns | Every completed chat turn |
| L1 | Memory extraction | Extracts concise memories from buffered chat | Threshold, idle timeout, shutdown flush |
| L2 | Scene extraction | Builds scene blocks and scene navigation | After successful L1, min/max interval |
| L3 | Persona generation | Builds `persona.md` from scenes | After L2, gated by `PersonaTrigger` |

Primary output:

- `records/*.jsonl`
- `conversations/*.jsonl`
- `scene_blocks/*.md`
- `scene_index.json`
- `persona.md`
- pipeline checkpoint/state

### 2.2 Offload

Offload is the context management system.

| Layer | Name | Purpose | Existing Trigger |
|---|---|---|---|
| L1 | Tool pair summarization | Summarizes tool call/result pairs into offload entries | Pending tool-pair threshold or after turn |
| L1.5 | Task boundary judgment | Decides if task continues, changes, or ends | After L1 flush |
| L2 | MMD generation | Builds Mermaid task graph from offload entries | Null-node threshold or time trigger |
| L3 | Context compression | Compresses chat history before/inside LLM calls | Before turn, after tool step, token pressure |
| L4 | Skill generation | Creates reusable skill docs from completed task context | Manual command |

Primary output:

- `offload/telegram-bot/session-*/offload-*.jsonl`
- `offload/telegram-bot/session-*/refs/*.md`
- `offload/telegram-bot/session-*/mmds/*.mmd`
- offload session `state.json`
- generated skills

### 2.3 Vendored Code Boundary

`TencentDB-Agent-Memory/` is treated as a vendored dependency. Changes to this spec that require modifying behavior inside the TDAI engine fall into two categories:

| Category | What changes | Where code lives | Required vendor edit? |
|---|---|---|---|
| **Adapter/Config/Wrapper (Phase 1, 2, 4, 5)** | Env var plumbing, new trigger scheduling, logging, status commands, new feature-gate checks, new observer/watcher code that calls existing TDAI APIs | Root `src/` files (`src/memory/`, `src/services/`, `src/telegram/`, `src/offload/`) | No. All changes stay in root adapters, config, or wrapper code. |
| **L2 pipeline internals (Phase 3a, 3b, 3c)** | Scene metadata schema changes, active/stale/archived status transitions, merge/dedup logic, injection policy changes | `TencentDB-Agent-Memory/src/core/scene/*` or `store/*` | **Yes** — these are deep pipeline changes. They require a PR against the TDAI repo, after which the vendor submodule is bumped. |
| **Offload internals (Phase 4)** | MMD size guards, wait-entry retry, reclaim logic | Root `src/offload/` or `TencentDB-Agent-Memory/src/offload/` | Depends on the change. Reclaim and size guards can live in root wrappers. Deep MMD pipeline changes require vendor edits. |

**Rule of thumb:** If the change touches the internal extraction, storage, or injection logic inside `TencentDB-Agent-Memory/src/core/`, it requires a vendor edit. If it lives in configuration, scheduling, logging, or event wiring in the root `src/`, it does not.

Phase 2 (catch-up triggers) and Phase 4 (offload hardening) are scoped to root code only. Phase 3 (scene maintenance) requires vendor edits for 3a (metadata schema changes live in `TencentDB-Agent-Memory/src/core/scene/`) and 3c (merge/dedup logic lives in `TencentDB-Agent-Memory/src/core/store/`). Phase 3b (injection policy) lives in the root `src/memory/` adapter — the vendor pipeline writes metadata to disk, and the root adapter reads it to decide which scenes to inject.

## 3. Current Risk Assessment

### 3.1 What Already Works

TDAI L1 has good catch-up behavior:

- threshold trigger
- idle timeout trigger
- shutdown flush
- retry on failure

TDAI L2 has partial catch-up behavior:

- runs after L1
- respects min interval
- has max interval polling for active sessions
- cold sessions stop polling to avoid waste

TDAI L3 persona has correctness gates:

- cold start if scenes exist and no persona exists
- recovery if persona body is missing
- first scene trigger
- memory threshold trigger
- explicit request trigger

Offload has good runtime integration:

- before-turn compression
- after-tool-step compression
- L1 fallback entries if LLM summarization fails
- L1.5 retry/failsafe
- L2 MMD scheduling

### 3.2 Weak Points

TDAI memory weak points:

1. Persona can become stale if L2 produces no scene changes or the threshold is never reached.
2. L2 can be delayed too long for low-volume users if L1 rarely completes.
3. L3 persona depends on L2 completing first.
4. Scene count can grow without active archive/merge policy.
5. Similar scenes can split into multiple scene blocks.
6. Long-running users can accumulate low-value memory and stale scenes.

Offload weak points:

1. Offload L2 only knows tool/offload entries, not all user memory.
2. Offload L3 compression is not persona generation.
3. If there are few or no tool calls, offload L1/L2 may have little data.
4. MMDs can become stale if L1.5 settles incorrectly or L2 fails repeatedly.
5. Offload data can grow without retention or reclaim.

## 4. Design Principles

1. Do not wait only for full thresholds.
   Every layer that can starve should have a catch-up trigger.

2. Do not generate high-level memory from nothing.
   Persona generation should require scene data or extracted memories.

3. Separate recall memory from compression memory.
   TDAI memory should optimize for user understanding. Offload should optimize for context size and task continuity.

4. Prefer incremental maintenance over emergency cleanup.
   Scene merge/archive and stale refresh should happen gradually.

5. Every skip must be explainable.
   Logs must show why L2/L3 ran or skipped.

6. All expensive LLM maintenance must be bounded.
   Use min intervals, concurrency locks, max scene counts, and retries.

## 5. TDAI Memory Autonomy Spec

### 5.1 L1 Memory Extraction

Current behavior is mostly sufficient.

Required behavior:

- Run on conversation threshold.
- Run on idle timeout even if threshold is not met.
- Run on graceful shutdown.
- Retry failed extraction with bounded attempts.
- Preserve buffered messages on failure.

Recommended config:

```env
MEMORY_PIPELINE_EVERY_N=10
MEMORY_PIPELINE_WARMUP=true
MEMORY_L1_IDLE_TIMEOUT=300
```

Notes:

- `MEMORY_L1_IDLE_TIMEOUT=300` means a low-volume user still gets extracted after 5 minutes of no new chat.
- Warmup should remain enabled because it extracts early sessions quickly.

### 5.2 L2 Scene Extraction

Current behavior:

- L2 is scheduled after L1 completes.
- L2 is rate-limited by `MEMORY_L2_MIN_INTERVAL`.
- L2 has max interval polling while session is active.

Additional required behavior:

1. Force-after-idle trigger.
   If a session has any pending L1-derived work and L2 has not run after N seconds, force L2.

2. Startup recovery trigger.
   If checkpoint says there is pending L2 work after restart, schedule L2 even if message buffers are empty.

3. Low-volume scene trigger.
   If a user has fewer than the normal threshold but has at least one meaningful extracted memory and L2 has never run, run L2 after idle.

4. Stale scene refresh.
   If scenes exist but scene index is older than N hours and the session is active, run L2 in maintenance mode.

**Definition: meaningful extracted memory.** A memory is considered meaningful for the low-volume trigger if all of the following hold:
- The L1 extraction produced non-empty content (the extracted text has at least one substantive sentence, where "substantive" means ≥3 tokens after stop-word removal).
- The extraction confidence score (if available) is at least 0.3.
- The memory category is in the allowlist: `preference`, `fact`, `event`, `goal`, `behavior`, `relationship`. Ephemeral, noise, and duplicate categories are excluded.
- The memory is not explicitly marked as ephemeral by the extraction prompt.
- At least one substantive noun or named entity is present in the extracted text (≥3 tokens after stop-word removal, or an embedding-based confidence threshold as the primary gate).

New config:

```env
MEMORY_L2_FORCE_AFTER_IDLE_SECONDS=900
MEMORY_L2_STARTUP_RECOVERY_DELAY_SECONDS=30
MEMORY_L2_STALE_REFRESH_HOURS=24
MEMORY_L2_MIN_NEW_MEMORIES=1
```

Trigger decision:

```text
Run L2 if:
  pending_l1_count > 0 and delay_after_l1 elapsed              (lastL1CompletedAt - lastL2CompletedAt >= delay)
  OR pending_l1_count > 0 and force_after_idle elapsed         (now - lastL2CompletedAt >= MEMORY_L2_FORCE_AFTER_IDLE_SECONDS)
  OR first meaningful memory exists and no scene exists         (lastMeaningfulMemoryAt is set, sceneCount == 0)
  OR scene index is stale and session active                   (now - sceneIndexUpdatedAt >= MEMORY_L2_STALE_REFRESH_HOURS)
  OR shutdown flush

Skip L2 if:
  no pending_work                                              (lastMemorySeqProcessedByL2 >= lastMemorySeqExtracted)
  OR no L1 memories and no useful conversation data
  OR min interval has not elapsed, unless forced by shutdown   (now - lastL2CompletedAt < MEMORY_L2_MIN_INTERVAL)
  OR another L2 for same session is running                    (l2JobStatus == "running")
  OR session is cold and this is only periodic maintenance     (sessionIsCold == true)
```

### 5.3 L2 Scene Maintenance

Scene extraction should not only create new scenes. It must maintain scene health.

Each scene should have metadata:

```ts
interface SceneMetadata {
  sceneId: string;
  title: string;
  status: "active" | "stale" | "resolved" | "archived";
  createdAt: string;
  updatedAt: string;
  lastReferencedAt: string;
  memoryCount: number;
  importanceScore: number;
  topicHash?: string;
}
```

Required scene maintenance:

- Update existing scene when new memory matches the same topic.
- Merge duplicate scenes when similarity is high.
- Mark inactive scenes as stale.
- Archive old stale scenes.
- Limit active scene count.
- Keep archived scenes searchable but not injected by default.

New config:

```env
MEMORY_SCENE_MAX_ACTIVE=30
MEMORY_SCENE_STALE_AFTER_DAYS=7
MEMORY_SCENE_ARCHIVE_AFTER_DAYS=21
MEMORY_SCENE_MERGE_ENABLED=true
MEMORY_SCENE_MERGE_THRESHOLD=0.86
```

Scene priority score:

```text
importanceScore =
  recency_weight
  + frequency_weight
  + explicit_user_importance_weight
  + unresolved_task_weight
  + tool_action_weight
  - stale_penalty
  - duplicate_penalty
```

Injection policy:

- Prefer active scenes.
- Include stale scenes only when directly relevant.
- Do not inject archived scenes unless recall explicitly matches them.
- Cap injected scene navigation by token budget.

### 5.4 L3 Persona Generation

Current behavior:

- Triggered after L2 completes.
- `PersonaTrigger` decides whether generation should run.

Additional required behavior:

1. Missing persona fallback.
   If `persona.md` does not exist or has no body, generate as soon as at least one scene exists.

2. Stale persona fallback.
   If persona is older than N hours/days and there are changed scenes or new memories, generate even if threshold is not met.

3. Low-volume first persona.
   If user has one scene and at least one extracted memory, generate a small persona.

4. Explicit admin/manual trigger.
   Allow forcing persona generation for a session.

5. Safe skip reasons.
   If persona is skipped, log the exact reason.

New config:

```env
MEMORY_PERSONA_MAX_STALE_HOURS=24
MEMORY_PERSONA_MIN_SCENES=1
MEMORY_PERSONA_MIN_CHANGED_SCENES=1
MEMORY_PERSONA_FORCE_IF_MISSING=true
MEMORY_PERSONA_MAX_CHARS=2000
```

Trigger decision:

```text
Run persona if:
  explicit request
  OR persona missing and scene_count >= MIN_SCENES             (lastPersonaAt == null, sceneCount >= MEMORY_PERSONA_MIN_SCENES)
  OR persona body empty and scene_count >= MIN_SCENES
  OR first scene exists and memories_since_last_persona > 0    (lastSceneSeqProcessedByPersona < lastSceneSeqExtracted)
  OR memories_since_last_persona >= MEMORY_PERSONA_TRIGGER_N
  OR persona age >= MAX_STALE_HOURS and changed_scene_count    (now - lastPersonaAt >= MEMORY_PERSONA_MAX_STALE_HOURS,
       >= MIN_CHANGED_SCENES                                     changedSceneCount >= MEMORY_PERSONA_MIN_CHANGED_SCENES)

Skip persona if:
  no scenes                                                    (sceneCount == 0)
  OR no memory-derived content exists
  OR persona recently generated and no changed scenes           (now - lastPersonaAt < MEMORY_PERSONA_MAX_STALE_HOURS)
  OR another persona job is running                            (personaJobStatus == "running")
```

Persona rules:

- Persona must be concise.
- Persona must be derived from scene data and extracted memory only.
- Persona must not include raw private secrets.
- Persona must not include temporary task details unless they represent stable user preference or long-term working style.
- Persona body should stay below `MEMORY_PERSONA_MAX_CHARS`.

### 5.5 Checkpoint State Fields

To make starvation prevention testable and to ground all trigger decisions in persistent state, the system MUST maintain the following checkpoint fields per session:

```ts
interface MemoryCheckpointState {
  // --- Sequencing counters ---
  lastMemorySeqExtracted: number;              // Sequence number of last L1 extraction
  lastMemorySeqProcessedByL2: number;          // Sequence number processed by L2
  lastSceneSeqExtracted: number;               // Sequence number of last scene block created
  lastSceneSeqProcessedByPersona: number;      // Sequence number processed by L3 persona

  // --- Timestamps ---
  lastL1CompletedAt: string | null;            // ISO-8601
  lastL2CompletedAt: string | null;            // ISO-8601
  lastPersonaAt: string | null;                // ISO-8601
  lastMeaningfulMemoryAt: string | null;       // ISO-8601 (set when a meaningful memory is extracted)
  sceneIndexUpdatedAt: string | null;          // ISO-8601 (last scene index write)

  // --- Job guards ---
  l2JobStatus: "idle" | "running" | "scheduled";
  personaJobStatus: "idle" | "running";

  // --- Activity signals ---
  sessionLastActiveAt: string;                 // ISO-8601 (updated on every user message)
  sessionIsCold: boolean;                      // true if no activity in MEMORY_SESSION_WINDOW_HOURS
}
```

### 5.6 Checkpoint Integration Strategy

The `MemoryCheckpointState` fields defined above are persisted in the same checkpoint file as the existing TDAI pipeline state (`dataDir/.metadata/recall_checkpoint.json`), but in a dedicated namespace key `"memory_autonomy_state"` to avoid collision with existing `runner_states` (L0/L1 owned) and `pipeline_states` (pipeline owned).

#### 5.6.1 Existing Checkpoint Architecture

The TDAI engine's `CheckpointManager` (`TencentDB-Agent-Memory/src/utils/checkpoint.ts`) provides:

- **Split-state design**: `runner_states` written by L0/L1 capture methods; `pipeline_states` written by `MemoryPipelineManager.persistStates()`. Neither side overwrites the other.
- **Atomic writes**: All mutations are serialized via a per-file async lock. Writes use tmp+rename to prevent corruption on crash.
- **Default merge**: `readRaw()` merges persisted JSON with `DEFAULT_CHECKPOINT` via `{ ...structuredClone(DEFAULT_CHECKPOINT), ...parsed }`, so extra keys in the JSON file survive read-modify-write cycles.
- **Existing pipeline fields**: `PipelineSessionState` already tracks `conversation_count`, `l2_pending_l1_count`, `last_extraction_time`, `l2_last_extraction_time`, `last_active_time`, and `warmup_threshold` per session.

#### 5.6.2 Namespace Strategy

The new checkpoint fields live under a single top-level key in the existing JSON file:

```json
{
  "last_captured_timestamp": ...,
  "total_processed": ...,
  "runner_states": { ... },
  "pipeline_states": { ... },
  "memory_autonomy_state": {
    "tg:user:12345": {
      "lastMemorySeqExtracted": 15,
      "lastMemorySeqProcessedByL2": 12,
      "lastSceneSeqExtracted": 3,
      "lastSceneSeqProcessedByPersona": 2,
      "lastL1CompletedAt": "2026-05-26T10:00:00.000Z",
      "lastL2CompletedAt": "2026-05-26T10:05:00.000Z",
      "lastPersonaAt": "2026-05-26T09:30:00.000Z",
      "lastMeaningfulMemoryAt": "2026-05-26T10:00:00.000Z",
      "sceneIndexUpdatedAt": "2026-05-26T10:05:00.000Z",
      "l2JobStatus": "idle",
      "personaJobStatus": "idle",
      "sessionLastActiveAt": "2026-05-26T10:10:00.000Z",
      "sessionIsCold": false
    },
    "tg:user:67890": { ... }
  }
}
```

This approach:

- **Requires zero vendor edits** (Phase 2 constraint). The extra key is transparently preserved by `CheckpointManager.readRaw()`.
- **Avoids name collision** with `runner_states` or `pipeline_states`.
- **Co-locates all session state** in one file, enabling atomic updates across old and new fields.
- **Backward compatible** with older checkpoints that lack the key — the root code treats a missing key as "all fields at initial values."

#### 5.6.3 Read/Write Protocol

The root adapter (`src/memory/`) owns the `memory_autonomy_state` namespace. It reads and writes through the `CheckpointManager`'s full `read()`/`write()` methods, which acquire the per-file lock. Specifically:

- **Read**: Call `checkpointManager.read()`, extract `cp.memory_autonomy_state[sessionKey]`, merge with defaults for missing fields.
- **Write**: Call `checkpointManager.read()` inside a `mutate()` call (or acquire the file path directly), update `cp.memory_autonomy_state[sessionKey]`, call `checkpointManager.write(cp)`.
- **Batch update**: On L1 completion (which updates `pipeline_states` via `mergePipelineStates()`), the root code reads the checkpoint, updates both `memory_autonomy_state` sequencing counters AND returns the updated checkpoint for atomic write-back.

Implementation sketch:

```ts
class MemoryAutonomyCheckpoint {
  private readonly cpManager: CheckpointManager;
  private readonly filePath: string;

  async getState(sessionKey: string): Promise<MemoryCheckpointState> {
    const cp = await this.cpManager.read();
    const autonomy = cp.memory_autonomy_state ?? {};
    return mergeDefaults(autonomy[sessionKey]);
  }

  async updateState(sessionKey: string, patch: Partial<MemoryCheckpointState>): Promise<void> {
    // Atomic read-modify-write via the existing checkpoint file lock
    await withFileLock(this.filePath, async () => {
      const cp = await this.cpManager.read();
      if (!cp.memory_autonomy_state) cp.memory_autonomy_state = {};
      const current = mergeDefaults(cp.memory_autonomy_state[sessionKey]);
      cp.memory_autonomy_state[sessionKey] = { ...current, ...patch };
      await this.cpManager.write(cp);
    });
  }
}
```

Where `mergeDefaults()` provides `0` for sequence counters, `null` for timestamps, `"idle"` for job status, and `false` for `sessionIsCold`.

#### 5.6.4 Atomicity Guarantees

- Every mutation to `memory_autonomy_state` MUST be serialized through the checkpoint file's per-file async lock (same lock used by `CheckpointManager` internally).
- Multiple `MemoryAutonomyCheckpoint` instances pointing at the same `dataDir` automatically share the same lock via the existing `fileLocks` map in `CheckpointManager`.
- Write operations use tmp+rename to prevent partial writes on crash.
- If the `memory_autonomy_state` key is missing on read (e.g., after a vendor upgrade that resets the checkpoint), the root code treats all sessions as at initial values — no data is lost because the sequencing counters start at 0, which means "no work since tracking began" and all catch-up triggers fire naturally.

#### 5.6.5 Migration from Current State

On first boot with the new checkpoint fields:

1. The `memory_autonomy_state` key does not exist in the checkpoint file.
2. The root code initializes it from the existing `pipeline_states` data:
   - `lastMemorySeqExtracted` ← `l2_pending_l1_count` from `PipelineSessionState`. **Note:** `l2_pending_l1_count` is a *difference* counter (L1 extractions not yet processed by L2), not an absolute total. Setting `lastMemorySeqExtracted = l2_pending_l1_count` and `lastMemorySeqProcessedByL2 = 0` means the computed delta (`extracted - processed = l2_pending_l1_count - 0`) correctly reflects the real pending count, but the absolute values are approximate. This is sufficient for trigger decisions (which only compare the delta against thresholds).
   - `lastL1CompletedAt` ← `last_extraction_time` from `PipelineSessionState`
   - `lastL2CompletedAt` ← `l2_last_extraction_time` from `PipelineSessionState`
   - `sessionLastActiveAt` ← `last_active_time` from `PipelineSessionState` (converted to ISO-8601)
   - All sequence-counters-to-date start at 0 (triggers will fire conservatively)
   - All other fields ← default values
3. This migration runs once, inside the checkpoint file lock, on the first read after boot.
4. After migration, the `memory_autonomy_state` key is written atomically alongside existing state.

This migration is idempotent: if the process crashes mid-migration, the next boot re-runs it (the key will still be missing because write never completed).

#### 5.6.6 Sync Strategy with PipelineSessionState

There is intentional overlap between `memory_autonomy_state` fields and `PipelineSessionState` fields:

| Field | `PipelineSessionState` source | `memory_autonomy_state` source | Sync direction |
|---|---|---|---|
| `lastL1CompletedAt` | `last_extraction_time` (written by `runL2`) | Explicitly updated by L1 callback | One-way: autonomy writes after L1, pipeline reads from checkpoint |
| `lastL2CompletedAt` | `l2_last_extraction_time` (written by `runL2`) | Explicitly updated by L2 trigger | One-way: autonomy writes after L2 trigger, pipeline reads |
| `sessionLastActiveAt` | `last_active_time` (written by `notifyConversation`) | Read from `PipelineSessionState.last_active_time` via the polling bridge (Section 14.7.3) or the root adapter wrapper around `core.handleTurnCommitted()`, converted to ISO-8601 | Duplicated intentionally to avoid vendor edit |
| Sequencing counters | Not present | `lastMemorySeqExtracted`, `lastMemorySeqProcessedByL2`, etc. | Autonomy-only |
| Job status guards | Not present | `l2JobStatus`, `personaJobStatus` | Autonomy-only |
| Activity signals | `last_active_time` (epoch ms) | `sessionIsCold`, `sessionLastActiveAt` (ISO-8601) | Derived from `last_active_time` |

**Rule**: When the scheduler decides whether to run L2/persona, it reads FROM `memory_autonomy_state` exclusively, not from `PipelineSessionState`. The `PipelineSessionState` fields continue to serve their existing purpose (L1 threshold detection, cold polling check inside `MemoryPipelineManager`). The two state stores are independent and mutually non-interfering.

#### 5.6.7 State Update Rules

The state update rules from Section 5.5 apply: every L1, L2, and L3 job MUST load the checkpoint before deciding, update fields atomically after completing or skipping, and persist before returning.

## 6. Offload Autonomy Spec

### 6.1 Offload L1

Purpose:

- Convert tool call/result pairs into compact entries.
- Enable L3 compression to replace large tool results with summaries.
- Provide data for L2 MMD generation.

Required behavior:

- Flush on `OFFLOAD_FORCE_TRIGGER_THRESHOLD`.
- Flush after turn if any pending tool pairs exist.
- Write degraded fallback entries if LLM summarization fails.
- Write ref files for large tool results.

Recommended config:

```env
OFFLOAD_ENABLED=true
OFFLOAD_L1_ENABLED=true
OFFLOAD_FORCE_TRIGGER_THRESHOLD=4
OFFLOAD_MAX_PAIRS_PER_BATCH=20
```

Skip conditions:

- No pending tool pairs.
- Offload disabled.
- L1 disabled.

Fallback behavior:

- If LLM summary fails, write degraded summary from raw tool result.
- Degraded entries should still be usable by L3 compression.

### 6.2 Offload L1.5

Purpose:

- Decide task boundary:
  - continuing current task
  - new task
  - short/casual chat
  - long task requiring MMD

Required behavior:

- Run after L1 flush when enough text exists.
- Retry a few times if LLM judge fails.
- Failsafe to "short" if judgment repeatedly fails.
- Store boundary data in session state.

Recommended config:

```env
OFFLOAD_L15_ENABLED=true
```

Skip conditions:

- L1 did not produce entries.
- Recent message text too short.
- No offload model available.

### 6.3 Offload L2 MMD

Purpose:

- Build/update Mermaid MMD files from offload entries.
- Track task progress from tool-heavy work.
- Provide structured context for future turns and skill generation.

Current trigger style:

- Trigger by null `node_id` count.
- Trigger by timeout since last L2.

Required behavior:

- Run when null node count reaches `OFFLOAD_L2_NULL_THRESHOLD`.
- Run when timeout elapses and there are new null entries.
- Retry `node_id="wait"` entries after wait-retry timeout.
- Backfill node IDs after MMD update.
- Never run two L2 jobs concurrently.

Recommended config:

```env
OFFLOAD_L2_ENABLED=true
OFFLOAD_L2_NULL_THRESHOLD=4
OFFLOAD_L2_TIMEOUT_SECONDS=300
OFFLOAD_BACKEND_TIMEOUT_MS=120000
```

Additional config:

```env
OFFLOAD_L2_WAIT_RETRY_SECONDS=120
OFFLOAD_L2_TIME_TRIGGER_REQUIRES_NEW_OFFLOAD=true
```

Skip conditions:

- No null/wait entries.
- No offload model.
- L2 disabled.
- L2 already running.

MMD maintenance:

- Patch existing MMD when possible.
- Replace only when patch fails or full rebuild is requested.
- Keep MMD files small enough for injection.
- Prefer current active MMD over old MMDs.

### 6.4 Offload L3 Compression

Purpose:

- Keep prompt under context window.
- Replace large tool results with L1 summaries.
- Delete old messages when mild compression is insufficient.
- Emergency trim on token overflow.

Required behavior:

- Run before every LLM turn when offload enabled.
- Run after tool steps when messages are available.
- Use token counter against `OFFLOAD_CONTEXT_WINDOW`.
- Mild compression first.
- Aggressive deletion second.
- Emergency deletion last.
- Respect MMD injection budget.

Recommended config:

```env
OFFLOAD_CONTEXT_WINDOW=128000
OFFLOAD_MILD_RATIO=0.85
OFFLOAD_AGGRESSIVE_RATIO=0.85
OFFLOAD_EMERGENCY_RATIO=0.95
OFFLOAD_EMERGENCY_TARGET_RATIO=0.6
OFFLOAD_AGGRESSIVE_DELETE_RATIO=0.4
OFFLOAD_MILD_SCAN_RATIO=0.7
OFFLOAD_MMD_MAX_TOKEN_RATIO=0.2
```

Important distinction:

- Offload L3 is compression.
- TDAI Memory L3 is persona generation.
- They must not be treated as the same layer.

### 6.5 Offload Reclaim

Purpose:

- Prevent offload data from growing forever.

Required behavior:

- Delete old JSONL/ref/MMD data after retention window.
- Keep recent active sessions.
- Do not delete active MMD while session references it.
- Log reclaim stats.

Recommended config:

```env
OFFLOAD_RETENTION_DAYS=14
OFFLOAD_LOG_MAX_SIZE_MB=50
```

Default can remain `0` for disabled retention, but production should use retention.

## 7. Cross-System Coordination

### 7.1 What Memory Can Learn From Offload

TDAI memory may use offload outputs as weak signals, not primary truth.

Allowed:

- Tool-heavy task summaries can inform scene importance.
- Completed MMD tasks can mark scenes as resolved.
- Repeated tool patterns can become user workflow preferences if stable.

Not allowed:

- Do not copy huge tool outputs into persona.
- Do not treat temporary offload entries as permanent user preference.
- Do not let offload MMD replace TDAI scene extraction.

### 7.2 What Offload Can Use From Memory

Offload may use memory outputs for context routing.

Allowed:

- Inject active persona/scene context into prompt before offload compression.
- Use current task scene title as MMD label.
- Use memory recall to improve L1.5 task boundary prompt.

Not required for phase 1:

- Direct cross-index between scene IDs and MMD node IDs.

## 8. Configuration Summary

### 8.1 New TDAI Memory Config

```env
MEMORY_L2_FORCE_AFTER_IDLE_SECONDS=900
MEMORY_L2_STARTUP_RECOVERY_DELAY_SECONDS=30
MEMORY_L2_STALE_REFRESH_HOURS=24
MEMORY_L2_MIN_NEW_MEMORIES=1

MEMORY_PERSONA_MAX_STALE_HOURS=24
MEMORY_PERSONA_MIN_SCENES=1
MEMORY_PERSONA_MIN_CHANGED_SCENES=1
MEMORY_PERSONA_FORCE_IF_MISSING=true
MEMORY_PERSONA_MAX_CHARS=2000

MEMORY_SCENE_MAX_ACTIVE=30
MEMORY_SCENE_STALE_AFTER_DAYS=7
MEMORY_SCENE_ARCHIVE_AFTER_DAYS=21
MEMORY_SCENE_MERGE_ENABLED=true
MEMORY_SCENE_MERGE_THRESHOLD=0.86
```

### 8.2 Existing TDAI Memory Config To Tune

```env
MEMORY_PIPELINE_EVERY_N=10
MEMORY_PIPELINE_WARMUP=true
MEMORY_L1_IDLE_TIMEOUT=300
MEMORY_L2_DELAY_AFTER_L1=30
MEMORY_L2_MIN_INTERVAL=600
MEMORY_L2_MAX_INTERVAL=1800
MEMORY_SESSION_WINDOW_HOURS=24
MEMORY_PERSONA_TRIGGER_N=20
```

### 8.3 Existing Offload Config To Tune

```env
OFFLOAD_ENABLED=true
OFFLOAD_L1_ENABLED=true
OFFLOAD_L15_ENABLED=true
OFFLOAD_L2_ENABLED=true
OFFLOAD_MODEL=gpt-5.4-mini

OFFLOAD_FORCE_TRIGGER_THRESHOLD=4
OFFLOAD_CONTEXT_WINDOW=128000
OFFLOAD_MAX_PAIRS_PER_BATCH=20

OFFLOAD_L2_NULL_THRESHOLD=4
OFFLOAD_L2_TIMEOUT_SECONDS=300

OFFLOAD_MILD_RATIO=0.85
OFFLOAD_AGGRESSIVE_RATIO=0.85
OFFLOAD_EMERGENCY_RATIO=0.95
OFFLOAD_EMERGENCY_TARGET_RATIO=0.6
OFFLOAD_RETENTION_DAYS=14
```

### 8.4 Scheduler Phase Config

```env
MEMORY_SCHEDULER_PHASE=none       # none | observer | active
```

- `none`: New scheduler runs no code. Existing `MemoryPipelineManager` handles all triggers.
- `observer`: New scheduler evaluates trigger conditions and logs what it *would* do, but does not dispatch any jobs (Phase 1 in Section 14.7.2).
- `active`: New scheduler dispatches L2/L3 jobs (Phase 2 or 3 in Sections 14.7.3–14.7.4).

### 8.5 Feature-Gate Flags for Independent Disable

Each new autonomous behavior introduced in this spec MUST have a dedicated feature-flag env var. Behaviors from Phase 2 that were deemed safe during design review default to on (`true`). Behaviors from Phases 3–5 that require production validation default to off (`false`) until explicitly enabled. This allows operators to disable individual behaviors independently without reverting the entire deployment.

```env
# --- TDAI Memory Feature Gates ---
MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=true
MEMORY_L2_STARTUP_RECOVERY_ENABLED=false
MEMORY_L2_STALE_REFRESH_ENABLED=false
MEMORY_PERSONA_STALE_REFRESH_ENABLED=true
MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED=true
MEMORY_SCENE_ARCHIVE_ENABLED=false
MEMORY_SCENE_MERGE_ENABLED=false

# --- Offload Feature Gates ---
OFFLOAD_RECLAIM_ENABLED=false
OFFLOAD_L2_WAIT_RETRY_ENABLED=false
```

Rollback procedure:

1. Set the offending feature flag to `false`.
2. Restart the bot.
3. Verify the problematic behavior stops via logs and status commands.
4. File an issue with the flag name and observed symptoms.

**Important:** feature gates guard the trigger/action side only. If a behavior was already partially executed (e.g., scenes were already archived), setting the gate to `false` stops future runs but does not undo past effects. Undo logic, if needed, must be handled by a separate manual recovery command.

## 9. Observability Requirements

Every autonomous trigger must emit a reasoned log.

### 9.1 TDAI Memory Logs

Required logs:

```text
[memory-tdai] [pipeline] L1 triggered reason=threshold|idle_timeout|flush|retry
[memory-tdai] [pipeline] L2 scheduled reason=after_l1|force_idle|startup_recovery|stale_refresh|shutdown
[memory-tdai] [pipeline] L2 skipped reason=no_pending_work|min_interval|cold_session|already_running
[memory-tdai] [persona] trigger reason=missing|empty|first_scene|threshold|stale|explicit
[memory-tdai] [persona] skipped reason=no_scenes|fresh|no_changed_scenes|already_running
[memory-tdai] [scene] maintenance archived=N merged=N active=N stale=N
```

### 9.2 Offload Logs

Required logs:

```text
[offload] L1 flush reason=threshold|after_turn|shutdown pending=N entries=N fallback=true|false
[offload] L1.5 judge result=continue|new_task|short|long retries=N
[offload] L2 scheduled reason=null_threshold|timeout|wait_retry
[offload] L2 skipped reason=no_entries|disabled|already_running|no_model
[offload] L3 compression before=X after=Y tier=mild|aggressive|emergency
[offload] reclaim jsonl=N refs=N mmds=N logs=N
```

### 9.3 Status Command Output

Add an admin-only command:

```text
/memory-status
```

Suggested output:

```text
Memory:
- L1 buffered messages: N
- L1 pending conversations: N
- Last L1: timestamp
- Last L2: timestamp
- L2 seq processed: N / L1 seq extracted: N
- Scene count: active=N stale=N archived=N
- Scene index updated: timestamp
- Persona updated: timestamp
- Persona stale: yes/no
- Persona age: N hours
- L2 job status: idle|running|scheduled
- Last meaningful memory: timestamp

Checkpoint:
- pending_l1_count: N
- lastMemorySeqProcessedByL2: N
- lastSceneSeqProcessedByPersona: N
- sessionIsCold: yes/no

Offload:
- Enabled: yes/no
- Pending tool pairs: N
- Offload entries: N
- Null node entries: N
- Active MMD: filename
- Last L2: timestamp
- L3 compression last saved tokens: N
```

## 10. Manual Recovery Commands

Admin-only commands:

```text
/memory-status
/memory-force-l1
/memory-force-l2
/memory-force-persona
/memory-scenes
/offload-status
/offload-force-l1
/offload-force-l2
/offload-reclaim
```

### 10.1 Admin Identity

Admin identity is determined by one of the following (checked in order):

1. **Telegram user ID allowlist.** A configured set of numeric user IDs (`ADMIN_USER_IDS=123,456`). This is the primary mechanism.
2. **Chat ID allowlist.** A configured set of group/supergroup chat IDs where any verified user is treated as admin for the duration of the chat session. Used for team-operated groups.
3. **Super-admin flag.** A single user ID (`SUPER_ADMIN_USER_ID=123`) that bypasses all restrictions and can run global-force commands.

Admin status MUST be checked on every command invocation. It must NOT be cached for longer than 5 minutes without revalidation.

### 10.2 Status Output Redaction

Status commands (`/memory-status`, `/offload-status`, `/memory-scenes`) MUST redact:

- Private keys, mnemonic phrases, and any wallet secrets.
- Raw message content from user conversations (show counts and metadata only).
- LLM API keys, base URLs, and model names if they differ from the configured default.
- Session IDs for inactive sessions (show session count only).

Allowed in status output:

- Aggregated counts, timestamps, status labels.
- Scene titles (but not raw memory content within scenes).
- Persona staleness indicator.
- Pipeline job status fields.

### 10.3 Global vs. Scoped Force Commands

Rules:

- Force commands are scoped to the requesting Telegram user's session by default.
- A force command becomes global (applies to all sessions) only if the user is the super-admin AND the command includes an explicit `--global` or `/global` flag.
- Global force commands MUST log: `[admin] global-force user=<id> command=<name> reason=<optional>`.
- Scoped force commands MUST log the requesting user ID and session ID.
- Command handlers MUST confirm destructive actions (reclaim, archive) with a second prompt requiring `--confirm` or a 5-second window for the user to type "confirm".

### 10.4 Security Considerations for Wallet-Access Context

Because this bot also manages wallet and private-key access flows:

- All memory and offload manual commands operate on memory/scene/offload data only. They MUST NOT accept wallet addresses, private keys, or seed phrases as arguments.
- Status output from memory commands MUST NOT include content that could contain wallet addresses or private keys (e.g., raw conversation text, raw L1 memory text).
- The `/memory-scenes` command output MUST be truncated to metadata-only (title, status, dates, importance) and MUST NOT include raw scene block content.
- If a scene title or memory content happens to contain a wallet address or key material, it MUST be redacted with `***` in the status output.

### 10.5 Command Logging

Every admin command invocation must produce a log entry containing:

- `user_id` (Telegram numeric ID)
- `username` if available
- `command` name
- `scope` = "self" | "global"
- `timestamp`
- `result` = "success" | "denied" | "error"
- `error_reason` if result is not success

## 11. Implementation Phases

### Phase 1: Visibility and Safe Config

Goal:

- No behavior risk.
- Add logs and status.

Tasks:

1. Add detailed skip/run reason logs for TDAI L2/L3.
2. Add detailed skip/run reason logs for Offload L1/L1.5/L2/L3.
3. Add `/memory-status` and `/offload-status`.
4. Document current env values.

Validation:

- Bot still behaves the same.
- Logs explain every pipeline decision.

### Phase 2: TDAI Catch-Up Triggers

Goal:

- Prevent L2/persona starvation.

Tasks:

1. Add `MEMORY_L2_FORCE_AFTER_IDLE_SECONDS`.
2. Add startup recovery delay for L2.
3. Add persona missing/stale fallback.
4. Add tests for low-volume chats producing first scene/persona.

Validation:

- A user with one or two meaningful chats eventually gets L1, L2, and persona.
- Persona does not generate when there are no scenes.

### Phase 3a: Scene Metadata and Status

Goal:

- Add structural metadata to scenes and define status lifecycle.

Tasks:

1. Add `SceneMetadata` schema with status, timestamps, importance score.
2. Add active/stale/resolved/archived status transitions.
3. Update pipeline to write metadata on scene creation and update.
4. Add scene maintenance logs.

Validation:

- Every scene has metadata after upgrade.
- Status transitions are logged and reversible by manual command.

### Phase 3b: Active/Stale/Archive Injection Policy

Goal:

- Control which scenes are injected into prompts based on status.

Tasks:

1. Add max active scene policy (`MEMORY_SCENE_MAX_ACTIVE`).
2. Add stale scene detection after `MEMORY_SCENE_STALE_AFTER_DAYS`.
3. Add archive after `MEMORY_SCENE_ARCHIVE_AFTER_DAYS`.
4. Modify recall/injection to prefer active scenes, include stale only on relevance, skip archived unless explicitly matched.

Validation:

- Active scene count stays below configured max.
- Injected scene budget is respected.
- Archived scenes remain searchable but are not injected by default.

### Phase 3c: Duplicate Detection and Merge

Goal:

- Prevent similar scenes from splitting into multiple blocks.

Tasks:

1. Add topic hash or embedding similarity for scene comparison.
2. Add merge-on-create logic: if similarity > `MEMORY_SCENE_MERGE_THRESHOLD`, append to existing scene instead of creating new.
3. Add batch dedup pass for existing scenes.
4. Log merge decisions with similarity scores.

Validation:

- Duplicate scenes are merged or flagged.
- Merge preserves memory history from both source scenes.

### Phase 4: Offload Hardening

Goal:

- Ensure offload remains useful and bounded.

Tasks:

1. Add wait-entry retry config.
2. Add status command for offload sessions.
3. Add reclaim command.
4. Add MMD size guard.
5. Add tests for L2 null threshold and timeout triggers.

Validation:

- Tool-heavy sessions produce offload entries and MMDs.
- MMD injection stays under token budget.

### Phase 5: Cross-System Coordination

Goal:

- Use offload and memory together without mixing responsibilities.

Tasks:

1. Let completed offload MMDs signal scene resolution.
2. Let scene title guide MMD naming.
3. Add optional link metadata between scene IDs and MMD node IDs.
4. Keep persona generation sourced from scenes/memories only.

Validation:

- Memory recall and offload compression improve each other without duplicating data.

## 12. Test Matrix

### TDAI Memory Tests

| Test | Expected |
|---|---|
| Low-volume user sends 1 useful chat then idles | L1 runs by idle timeout |
| L1 completes, L2 delay elapsed | L2 runs |
| Persona missing and one scene exists | L3 persona runs |
| Persona fresh and no changed scenes | L3 skips with reason |
| Persona stale and changed scene exists | L3 runs |
| Too many active scenes | oldest/lowest-score scenes archived |
| Duplicate scenes detected | scenes merged or marked duplicate |
| Checkpoint fields persisted after L2 run | lastL2CompletedAt updated, lastMemorySeqProcessedByL2 advances |
| Checkpoint fields persisted after persona run | lastPersonaAt updated, lastSceneSeqProcessedByPersona advances |
| Meaningful memory filter applied | ephemeral/noise memories excluded from trigger count |
| Feature gate disabled (MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=false) | force-after-idle trigger skipped despite elapsed time |

### Offload Tests

| Test | Expected |
|---|---|
| Tool pairs reach threshold | Offload L1 flushes |
| L1 summarization fails | degraded entries written |
| Null node entries reach threshold | Offload L2 runs |
| L2 fails mapping | entries marked wait and retried later |
| Context exceeds mild ratio | L3 mild compression runs |
| Context exceeds emergency ratio | emergency compression runs |
| Retention enabled | old offload files reclaimed |
| Feature gate disabled (OFFLOAD_RECLAIM_ENABLED=false) | reclamation skipped entirely |

### Integration Tests

| Scenario | Expected |
|---|---|
| Long casual chat, no tools | TDAI memory grows; offload mostly idle |
| Tool-heavy task | Offload grows; TDAI captures stable user facts only |
| Many small sessions | No unbounded timers or state maps |
| Restart with pending work | L2 recovery schedules safely |
| Persona stale after time passes | Persona refreshes after new scene change |
| Admin command without --global flag | scoped to requesting session only |
| Admin command with --global flag by non-super-admin | denied with logged reason |
| Session restarts with pending L2 work | checkpoint lastMemorySeqProcessedByL2 < lastMemorySeqExtracted, recovery schedules L2 |
| Scheduler global concurrency limit reached | L2 job queued, log emitted, not dispatched |
| Cold session cleanup | session's in-memory queue emptied, sessionIsCold=true |

## 13. Success Metrics

Memory quality:

- Persona exists for active users after low-volume usage.
- Persona age stays below configured stale threshold for active users.
- Active scene count stays below configured max.
- Recall uses archived scenes only when relevant.

Operational quality:

- No repeated unbounded L2/L3 jobs.
- No duplicate persona jobs.
- Offload files do not grow without retention.
- Token overflow errors decrease.
- Timeout errors recover by retry when transient.

Debuggability:

- Every L1/L2/L3 skip has a logged reason.
- `/memory-status` can identify stuck state.
- `/offload-status` can identify missing MMD or stuck null nodes.

## 14. Scheduler and Concurrency Model

### 14.1 Ownership Model

All autonomous triggers (idle timers, stale refresh, startup recovery, max interval polling, and manual force commands) are managed by a single global scheduler instance:

```ts
interface SchedulerConfig {
  globalConcurrencyLimit: number;      // Max concurrent pipeline jobs across all sessions. Default: 3
  sessionQueueCapacity: number;        // Max scheduled jobs per session queue. Default: 5
  coldSessionCleanupIntervalMs: number; // How often to scan for cold sessions. Default: 600_000 (10 min)
  coldSessionTimeoutMs: number;        // Session idle duration before cleanup. Default: 3600_000 (1 hour)
}
```

### 14.2 One Scheduler per Session, Gated Globally

- Each session gets one logical job queue (in-memory, backed by checkpoint).
- The global scheduler dispatches jobs from session queues respecting `globalConcurrencyLimit`.
- If `globalConcurrencyLimit` is reached, additional jobs are queued but not dispatched. A log line is emitted: `[scheduler] concurrency limit reached queued_session=<id>`.
- A session must not have two concurrent pipeline jobs of the same type (L2, persona). The checkpoint `l2JobStatus` / `personaJobStatus` guards this.

### 14.3 Concurrency Scoping

| Trigger Type | Per-Session Concurrency | Global Concurrency |
|---|---|---|
| Idle timeout L2 | At most 1 per session | Counts toward global limit |
| Stale refresh L2 | At most 1 per session | Counts toward global limit |
| Startup recovery L2 | At most 1 per session | Counts toward global limit |
| Max interval polling L2 | At most 1 per session | Counts toward global limit |
| Persona generation | At most 1 per session | Counts toward global limit |
| Manual force command | Bypasses per-session concurrency guard, counts toward global | Counts toward global limit |

### 14.4 Cold Session Cleanup

- On every `coldSessionCleanupIntervalMs` tick, the scheduler scans all tracked sessions.
- A session is cold if `sessionLastActiveAt + coldSessionTimeoutMs < now`.
- Cold sessions:
  - Have their in-memory job queue emptied.
  - Have their checkpoint `sessionIsCold` set to `true`.
  - Are NOT removed from state entirely (data remains on disk for startup recovery).
  - Are exempt from periodic maintenance triggers.
  - Are resubjected to idle/stale triggers only if a new user message arrives (which clears `sessionIsCold`).

### 14.5 Timer Management

- Idle timers are per-session, single-shot timers. They are reset on every new user message.
- Max interval polling uses a recurring timer per active session. It is cancelled when the session goes cold.
- Stale refresh uses a single global interval timer that iterates active sessions.
- Startup recovery is a single-shot timer started at boot with `MEMORY_L2_STARTUP_RECOVERY_DELAY_SECONDS` delay.
- All timers are held in a single registry (`Map<sessionId, TimerHandle>`) managed by the scheduler. On shutdown, all timers are cleared.
- Timer registry size is bounded by the number of distinct active sessions. If memory pressure is a concern, the scheduler can cap active session tracking to e.g. 100 most recently active sessions.

### 14.6 Logging

Every scheduler action must log:

```text
[scheduler] dispatch session=<id> job=<L2|persona> trigger=<type> queue_depth=N
[scheduler] complete session=<id> job=<L2|persona> duration_ms=N
[scheduler] skip session=<id> job=<L2|persona> reason=concurrency_limit|cold_session|already_running
[scheduler] cleanup cold_sessions=N remaining=N
```

### 14.7 Scheduler Migration Path

The existing TDAI engine includes an internal scheduler (`MemoryPipelineManager` in `TencentDB-Agent-Memory/src/utils/pipeline-manager.ts`) that already manages L1 idle timers, L2 downward-only timers (delay-after-L1 + max-interval polling), and L3 dedup. The proposed global scheduler (Sections 14.1–14.6) adds new catch-up triggers (force-after-idle, startup recovery, stale refresh, cold session cleanup) and a global concurrency model that the existing scheduler does not provide.

**These two schedulers must coexist during the rollout without double-fire.**

#### 14.7.1 Existing Scheduler Responsibilities

The existing `MemoryPipelineManager` handles:

- **L1 message buffering**: `notifyConversation()` increments `conversation_count`, buffers messages, triggers L1 on threshold or idle timeout.
- **L1 idle timer**: Per-session resettable timer; fires L1 after inactivity.
- **L1 warmup mode**: Exponential threshold (1 → 2 → 4 → 8 → ... → `everyNConversations`).
- **L2 timer (downward-only)**: After L1 completes, fires L2 at `max(now + delay, lastL2 + minInterval)`. After L2 completes, arms maxInterval timer at `now + maxInterval`.
- **L2 cold detection**: Skips maxInterval polling for sessions inactive > `sessionActiveWindowHours`.
- **L2 concurrency guard**: Per-session `l2Queued` flag prevents double-fire.
- **L3 trigger**: After each successful L2, calls `triggerL3()` (global dedup, concurrency=1).
- **Startup recovery**: `recoverPendingSessions()` arms L2 timers for sessions with pending L1 work from before restart.
- **Session GC**: Periodic eviction of cold sessions from in-memory maps.
- **Graceful shutdown**: `_doFlush()` flushes pending L1, L2, L3 work.

#### 14.7.2 Phase 1: Observer Mode (No Behavioral Change)

The new global scheduler is initialized at boot alongside the existing `MemoryPipelineManager`. It operates in observer mode:

- It tracks per-session entries in memory only (no checkpoint writes) and reads `memory_autonomy_state` checkpoints to evaluate what it *would* do.
- When a user message arrives, the root `context-agent.ts` or `ChatService` notifies BOTH the existing `MemoryPipelineManager` (via `core.handleTurnCommitted()` → `notifyConversation()`) and the new scheduler (via `scheduler.notifyActivity(sessionKey)`).
- The new scheduler evaluates trigger conditions (force-after-idle, stale refresh, startup recovery, concurrency limits) and emits log lines beginning with `[scheduler] [observer]` describing what it *would* do, but does NOT dispatch any jobs.
- The existing `MemoryPipelineManager` continues to fire L2/L3 as before.
- Phase 1 validates: log comparison between old scheduler triggers and new scheduler observer logs confirms they agree.

Env for Phase 1:

```env
MEMORY_SCHEDULER_PHASE=observer
```

#### 14.7.3 Phase 2: Partial Migration — L2 Catch-Up Triggers

The new scheduler takes over L2 trigger decisions for the new catch-up triggers (force-after-idle, startup recovery, stale refresh). The existing scheduler continues to handle L1 buffering and idle timeouts.

**What changes:**

1. The new scheduler registers a callback that the existing `MemoryPipelineManager` calls instead of arming its own L2 timer. Specifically, the L1 completion handler in `MemoryPipelineManager.runL1()` currently calls `advanceL2Timer()` — this call is replaced by a callback to the new scheduler. The new scheduler decides whether to dispatch L2 based on its own trigger logic, which INCLUDES the existing delay-after-L1 behavior.

2. **L2 trigger ownership**: The new scheduler owns ALL L2 trigger decisions. The existing scheduler's L2 timer management (`advanceL2Timer()`, `armL2MaxInterval()`, `onL2TimerFired()`) is disabled via a feature gate.

3. **L1 remains in the existing scheduler**: Message buffering, conversation threshold detection, idle timeouts, warmup mode, and retry logic stay in `MemoryPipelineManager`. The root code passes an `onL1Complete` callback to the existing scheduler that notifies the new scheduler.

**Callback interface (root code, no vendor edit needed because it wraps `MemoryPipelineManager` via a root adapter):**

```ts
interface L2TriggerDelegate {
  onL1Completed(sessionKey: string): void;
  onSessionActivity(sessionKey: string): void;
  onShutdown(): Promise<void>;
}
```

Because adding a callback to `MemoryPipelineManager` requires a vendor edit, Phase 2 uses a **polling bridge**:

- The root code runs a polling loop (every 2 seconds) that watches the checkpoint file for changes.
- When it detects that `pipeline_states[sessionKey].l2_pending_l1_count` has advanced (L1 completed), it calls `onL1Completed` on the new scheduler.
- When it detects that `pipeline_states[sessionKey].last_active_time` has advanced (new activity), it calls `onSessionActivity`.
- The new scheduler evaluates all trigger conditions and determines whether to dispatch L2.

This polling approach avoids vendor edits entirely for Phase 2. The polling overhead is negligible (2-second interval, single file stat + read). The maximum latency between L1 completion and new scheduler evaluation is 0–2 seconds. This is acceptable for catch-up triggers because L2 is not time-critical at sub-second granularity.

**Controlling the old scheduler's L2 timers:**

Since we cannot modify `MemoryPipelineManager` internals without a vendor edit, the old scheduler's L2 timers are disabled indirectly:

| Old trigger | How disabled |
|---|---|
| `advanceL2Timer()` called after L1 | Minimized by setting `MEMORY_L2_DELAY_AFTER_L1` to a very large value (e.g., `604800` = 7 days). The old timer fires 7 days after L1 — far past the new scheduler's ~15-minute force-after-idle trigger. The old timer is defeated by time magnitude, not by the session window check. |
| `armL2MaxInterval()` called after L2 | Minimized by setting `MEMORY_L2_MAX_INTERVAL` to a very large value — timer still fires but far past the point where the new scheduler already dispatched L2. |
| `recoverPendingSessions()` at boot | The new scheduler's startup recovery trigger runs at boot and dispatches before the old timer fires. |

This indirect disable is imperfect: a race window exists where the old timer fires milliseconds before the new scheduler dispatches. To eliminate this, a tiny vendor edit to `MemoryPipelineManager` is recommended (add a `disableL2Timers: boolean` flag that short-circuits `advanceL2Timer()` and `armL2MaxInterval()`). This vendor edit is a single boolean check (non-invasive, backward compatible).

**Avoiding double-fire:**

1. The new scheduler checks `memory_autonomy_state.l2JobStatus !== "idle"` before dispatching.
2. The new scheduler writes `l2JobStatus = "scheduled"` atomically before enqueuing.
3. The old scheduler's `l2Queued` flag still prevents its own internal double-fire, but since its L2 timer is effectively disabled (per above), it will rarely fire.
4. On the rare occasion both fire concurrently, the L2 runner itself is guarded by `SerialQueue` — the second enqueue is queued and executes after the first completes, and L2 is idempotent (it reads incremental cursor, so re-running with no new data is a no-op).

#### 14.7.4 Phase 3: Full Migration (L1 + L2 + L3)

If Phase 2 is stable, the remaining triggers are migrated to the new scheduler:

| Responsibility | Old scheduler | New scheduler (Phase 3) |
|---|---|---|
| L1 message buffering | `notifyConversation()` | Stays in old scheduler (tightly coupled to TDAI internals) |
| L1 idle timer | `onL1IdleTimeout()` | Replaced by new scheduler's idle trigger using checkpoint timestamp |
| L1 warmup mode | `advanceWarmupThreshold()` | Stays in old scheduler |
| L2 delay-after-L1 | `advanceL2Timer()` | New scheduler handles via `onL1Completed` callback |
| L2 maxInterval polling | `armL2MaxInterval()` | New scheduler's max interval trigger |
| L2 force-after-idle | Not present | New scheduler only |
| L2 startup recovery | `recoverPendingSessions()` | New scheduler's startup recovery trigger |
| L2 stale refresh | Not present | New scheduler only |
| L3 trigger | `triggerL3()` after L2 | New scheduler dispatches L3 after L2 |
| L3 dedup | `l3Pending` / `l3Running` flags | New scheduler's global persona concurrency limit |
| Session GC | `gcStaleSessions()` | New scheduler's cold session cleanup |

In Phase 3, the existing `MemoryPipelineManager` is reduced to L0 message buffering and L1 threshold/idle triggers only. All L2/L3 scheduling decisions are handled by the new scheduler. The polling bridge from Phase 2 is replaced by a direct callback, which requires a one-time vendor edit to add the `L2TriggerDelegate` callback to the `MemoryPipelineManager` constructor:

```ts
// One-time vendor edit: TencentDB-Agent-Memory/src/utils/pipeline-manager.ts
export interface L2TriggerDelegate {
  onL1Completed(sessionKey: string): void;
  onSessionActivity(sessionKey: string): void;
  onShutdown(): Promise<void>;
}

// The delegate is stored as a private field and called inside:
// - runL1() → after L1 completes, calls this.delegate.onL1Completed(sessionKey)
// - notifyConversation() → on any new message, calls this.delegate.onSessionActivity(sessionKey)
// - _doFlush() → on shutdown, calls this.delegate.onShutdown()
```

This vendor edit is non-invasive (optional field, defaulting to undefined), backward compatible, and eliminates the polling bridge for lower latency and simpler code.

#### 14.7.5 Rollback During Migration

If a bug is found at any phase:

- **Phase 1 (observer)**: Set `MEMORY_SCHEDULER_PHASE=none` — the new scheduler runs zero code. No behavioral impact. Also set all new catch-up feature gates to `false`.
- **Phase 2 (partial)**: Restore `MEMORY_L2_DELAY_AFTER_L1` and `MEMORY_L2_MAX_INTERVAL` to their original values (30 and 1800 respectively). Explicitly set all new catch-up feature gates to `false`: `MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=false`, `MEMORY_L2_STARTUP_RECOVERY_ENABLED=false`, `MEMORY_L2_STALE_REFRESH_ENABLED=false`. The old scheduler's L2 timers resume their original behavior.
- **Phase 3 (full)**: Revert to Phase 2 env values (restore old timer values, disable all new feature gates) and restart.

#### 14.7.6 Implementation Dependencies

| Phase | Prerequisites |
|---|---|
| Phase 1 (observer) | Section 5.6 checkpoint integration (read `memory_autonomy_state`). The scheduler reads but does not write. |
| Phase 2 (partial) | Section 5.6 checkpoint integration complete (read + write). Feature gate env vars defined (Section 8.5). Polling bridge code in root `src/services/scheduler.ts`. |
| Phase 3 (full) | Phase 2 stable. Optional vendor edit to add `L2TriggerDelegate` callback to `MemoryPipelineManager`. |

Phase 1 and Phase 2 can be implemented in the same release cycle. Phase 3 is recommended only after production validation of Phase 2.

## 15. Non-Goals

This spec does not require:

- Replacing TDAI memory with offload.
- Replacing offload MMDs with TDAI scenes.
- Generating persona from raw full chat history.
- Running L2/L3 on every message.
- Keeping unlimited active scenes.
- Making every command available to non-admin users.

## 16. Recommended Initial Rollout Values

For the current Telegram bot, start conservative:

```env
MEMORY_PIPELINE_EVERY_N=10
MEMORY_PIPELINE_WARMUP=true
MEMORY_L1_IDLE_TIMEOUT=300
MEMORY_L2_DELAY_AFTER_L1=30
MEMORY_L2_MIN_INTERVAL=600
MEMORY_L2_MAX_INTERVAL=1800
MEMORY_PERSONA_TRIGGER_N=20

MEMORY_L2_FORCE_AFTER_IDLE_SECONDS=900
MEMORY_L2_FORCE_AFTER_IDLE_ENABLED=true
MEMORY_L2_STARTUP_RECOVERY_ENABLED=false
MEMORY_L2_STALE_REFRESH_ENABLED=false
MEMORY_PERSONA_MAX_STALE_HOURS=24
MEMORY_PERSONA_MIN_SCENES=1
MEMORY_PERSONA_STALE_REFRESH_ENABLED=true
MEMORY_PERSONA_FORCE_IF_MISSING_ENABLED=true
MEMORY_SCENE_MAX_ACTIVE=30
MEMORY_SCENE_ARCHIVE_ENABLED=false
MEMORY_SCENE_MERGE_ENABLED=false

OFFLOAD_ENABLED=true
OFFLOAD_L1_ENABLED=true
OFFLOAD_L15_ENABLED=true
OFFLOAD_L2_ENABLED=true
OFFLOAD_FORCE_TRIGGER_THRESHOLD=4
OFFLOAD_L2_NULL_THRESHOLD=4
OFFLOAD_L2_TIMEOUT_SECONDS=300
OFFLOAD_RETENTION_DAYS=14
OFFLOAD_RECLAIM_ENABLED=false
OFFLOAD_L2_WAIT_RETRY_ENABLED=false
```

This gives the system four safety nets:

1. Threshold trigger for normal volume.
2. Idle trigger for low volume.
3. Stale trigger for long-running sessions.
4. Manual force command for recovery.

