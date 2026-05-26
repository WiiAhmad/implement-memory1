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
  pending_l1_count > 0 and delay_after_l1 elapsed
  OR pending_l1_count > 0 and force_after_idle elapsed
  OR first meaningful memory exists and no scene exists and idle elapsed
  OR scene index is stale and session active
  OR shutdown flush

Skip L2 if:
  no L1 memories and no useful conversation data
  OR min interval has not elapsed, unless forced by shutdown
  OR another L2 for same session is running
  OR session is cold and this is only periodic maintenance
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
  OR persona missing and scene_count >= min_scenes
  OR persona body empty and scene_count >= min_scenes
  OR first scene exists and memories_since_last_persona > 0
  OR memories_since_last_persona >= MEMORY_PERSONA_TRIGGER_N
  OR persona age >= max_stale_hours and changed_scene_count >= min_changed_scenes

Skip persona if:
  no scenes
  OR no memory-derived content exists
  OR persona recently generated and no changed scenes
  OR another persona job is running
```

Persona rules:

- Persona must be concise.
- Persona must be derived from scene data and extracted memory only.
- Persona must not include raw private secrets.
- Persona must not include temporary task details unless they represent stable user preference or long-term working style.
- Persona body should stay below `MEMORY_PERSONA_MAX_CHARS`.

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
- Scene count: active=N stale=N archived=N
- Persona updated: timestamp
- Persona stale: yes/no

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

Rules:

- Force commands must be scoped to the requesting Telegram user session by default.
- Global force commands should require a separate admin flag.
- Commands must log who requested them.
- Commands must not expose private key data or raw secrets.

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

### Phase 3: Scene Maintenance

Goal:

- Keep many scenes usable.

Tasks:

1. Add scene metadata if missing.
2. Add active/stale/archived state.
3. Add max active scene policy.
4. Add duplicate scene merge.
5. Add scene maintenance logs.

Validation:

- Active scene count stays below configured max.
- Archived scenes remain searchable but are not injected by default.

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

### Integration Tests

| Scenario | Expected |
|---|---|
| Long casual chat, no tools | TDAI memory grows; offload mostly idle |
| Tool-heavy task | Offload grows; TDAI captures stable user facts only |
| Many small sessions | No unbounded timers or state maps |
| Restart with pending work | L2 recovery schedules safely |
| Persona stale after time passes | Persona refreshes after new scene change |

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

## 14. Non-Goals

This spec does not require:

- Replacing TDAI memory with offload.
- Replacing offload MMDs with TDAI scenes.
- Generating persona from raw full chat history.
- Running L2/L3 on every message.
- Keeping unlimited active scenes.
- Making every command available to non-admin users.

## 15. Recommended Initial Rollout Values

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
MEMORY_PERSONA_MAX_STALE_HOURS=24
MEMORY_PERSONA_MIN_SCENES=1
MEMORY_SCENE_MAX_ACTIVE=30

OFFLOAD_ENABLED=true
OFFLOAD_L1_ENABLED=true
OFFLOAD_L15_ENABLED=true
OFFLOAD_L2_ENABLED=true
OFFLOAD_FORCE_TRIGGER_THRESHOLD=4
OFFLOAD_L2_NULL_THRESHOLD=4
OFFLOAD_L2_TIMEOUT_SECONDS=300
OFFLOAD_RETENTION_DAYS=14
```

This gives the system four safety nets:

1. Threshold trigger for normal volume.
2. Idle trigger for low volume.
3. Stale trigger for long-running sessions.
4. Manual force command for recovery.

