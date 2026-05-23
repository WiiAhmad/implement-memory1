# Context Offload Module — Implementation Plan

## Status: Draft v3 (Full deep-dive analysis)

Based on: `docs/specs/2026-05-22-offload-implementation-design.md` (v3)

---

## Strategy Decision

**Decision: Strategy B (Direct Import).**

The library's `registerOffload()` function is tightly coupled to the OpenClaw `api` object (~1300 lines of OpenClaw-specific hook wiring). Strategy B imports individual algorithms directly — the L3 compression functions, `LocalLlmClient`, `OffloadStateManager`, and storage functions — all of which have **zero OpenClaw dependency**.

**What we gain by skipping `registerOffload()`:**
- No OpenClaw shim to build (~200 lines of fragile mock code)
- No risk of OpenClaw hook signature changes breaking integration
- Clean separation of concerns: `OffloadService` wrapper owns its lifecycle

**What we must implement ourselves:**
- Module-level state (L2 poll timer, L1.5 retry, reclaim timer) in our wrapper
- L2 scheduling logic (library uses module-level `setTimeout`)
- L1.5 retry loop (library uses module-level `_l15Disposed` flag)

---

## Phase 0: Foundation — Config & Scaffolding (Estimated: 1 session)

### Goal
Add offload env vars, config types, and `OffloadService` class skeleton. Bot still works identically with offload disabled.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 0.1 | Add offload env vars to `AppEnv` schema | `src/config/env.ts` | Add `OFFLOAD_ENABLED`, `OFFLOAD_MODEL`, `OFFLOAD_TEMPERATURE`, `OFFLOAD_CONTEXT_WINDOW`, `OFFLOAD_L1_ENABLED`, `OFFLOAD_L15_ENABLED`, `OFFLOAD_L2_ENABLED`, `OFFLOAD_RETENTION_DAYS` |
| 0.2 | Update env test expectations | `src/config/env.test.ts` | Assert new env vars are parsed correctly with defaults |
| 0.3 | Define `OffloadConfig` type | `src/offload/types.ts` | Interface matching spec §9.1. Re-export library types: `OffloadEntry`, `PluginConfig`, `PLUGIN_DEFAULTS` |
| 0.4 | Create `src/offload/` directory | `src/offload/index.ts` | Export `OffloadService` class skeleton with `beforeTurn()`, `onToolCall()`, `afterTurn()`, `close()` — all no-ops when disabled |
| 0.5 | Add offload section to `buildTdaiRawConfig` | `src/memory/build-memory-config.ts` | Add explicit `offload: { enabled: false }` for consistency |
| 0.6 | Wire in `main.ts` | `src/main.ts` | Parse offload config from env, instantiate `OffloadService` (or `undefined` when disabled), pass to `ChatService` |
| 0.7 | Add optional offload param to `ChatService` | `src/services/chat-service.ts` | `constructor` accepts optional `offloadService`; `replyToUser()` calls `beforeTurn()` / `afterTurn()` when present |

### Prerequisite: Install Required Packages

| Package | Purpose | Installation |
|---|---|---|
| `js-tiktoken` | BPE token counting for L3 compression (used by `context-token-tracker.ts`) | `bun add js-tiktoken` |
| `ai` | Vercel AI SDK for LLM calls (used by `llm-caller.ts` for L1/L1.5/L2) | `bun add ai` |
| `@ai-sdk/openai` | OpenAI-compatible provider for `ai` SDK (used by `llm-caller.ts`) | `bun add @ai-sdk/openai` |

**Important:** Without `js-tiktoken`, L3 compression falls back to character-count estimation (less accurate but functional). Without `ai` + `@ai-sdk/openai`, the `LocalLlmClient` for L1/L1.5/L2 will fail at import time.

### Dependencies
None (new infrastructure)

### Validation
- `bun test src/config/env.test.ts` passes
- `bun check` (typecheck) passes
- Bot starts and shuts down cleanly with offload disabled (default)
- Bot starts and shuts down cleanly with offload enabled (no-op skeleton)

### File Changes Summary
```
NEW  src/offload/index.ts          ← Skeleton class
NEW  src/offload/types.ts          ← Types + library re-exports
MOD  src/config/env.ts             ← +8 env vars
MOD  src/config/env.test.ts        ← +8 assertions
MOD  src/memory/build-memory-config.ts  ← +offload section
MOD  src/main.ts                   ← Instantiation + wiring
MOD  src/services/chat-service.ts  ← Optional parameter + hook calls
```

---

## Phase 1: Storage & State Wrappers (Estimated: 1 session)

### Goal
Wrap library storage and state-management classes with the bot's data directory and session key format. All library imports must work under Bun.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 1.1 | Create storage wrapper | `src/offload/storage.ts` | Wrap library `createStorageContext()`, `readOffloadEntries()`, `appendOffloadEntries()`, `readAllOffloadEntries()`, `markOffloadStatus()`, `writeMmd()`, `readMmd()`, `listMmds()`, `deleteMmd()`. Map Telegram user keys to agent name. |
| 1.2 | Create state-manager wrapper | `src/offload/state-manager.ts` | Wrap library `OffloadStateManager` — `init()`, `switchSession()`, `save()`, `load()`. Handle per-user session routing. |
| 1.3 | Create session-key mapping | `src/offload/storage.ts` | Map `"tg:user:{id}"` → `"agent:telegram-bot:{id}"` format expected by `parseSessionKey()` |
| 1.4 | Verify library imports under Bun | Manual test | Run `bun -e "import { createStorageContext } from '.../offload/storage.ts'; console.log('ok')"` for each import module. Fix any path issues. |
| 1.5 | Write unit test for session key mapping | `src/offload/storage.test.ts` | Verify `"tg:user:12345"` maps to expected agent name and session ID |

### Dependencies
- Phase 0 complete

### Key Library Imports to Verify

| Import | Path | Notes |
|---|---|---|
| `createStorageContext` | `TencentDB-Agent-Memory/src/offload/storage.ts` | Returns `{ dataDir, sessionDir, refsDir, mmdsDir, ... }` |
| `readOffloadEntries` | Same | Reads N most recent entries |
| `appendOffloadEntries` | Same | Atomic write + rename |
| `readAllOffloadEntries` | Same | Full JSONL read |
| `markOffloadStatus` | Same | Batch update node_id/score |
| `writeMmd` | Same | Write MMD file |
| `parseSessionKey` | Same | Parse `agent:name:id` format |
| `OffloadStateManager` | `.../offload/state-manager.ts` | Per-session state with save/load |
| `SessionRegistry` | `.../offload/session-registry.ts` | LRU cache (max 20 sessions) |
| `PluginLogger` | `.../offload/types.ts` | Logger interface |

### Risk: Bun Compatibility
The library modules use `.js` extensions in relative imports (e.g., `"./state-manager.js"`). Bun handles this fine. But `node:fs/promises` and `node:path` usage in `storage.ts` should be tested on Windows.

### Validation
- `bun test src/offload/storage.test.ts` passes
- `bun check` passes (all library imports resolve)
- Manual: verify `data/memory-tdai/offload/telegram-bot/` directory is created on first use

---

## Phase 2: Token Counter & L3 Compressor (Estimated: 1 session)

### Goal
Implement the core L3 compression orchestrator using library algorithms. This is the primary value of MVP — prevents context window overflow.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 2.1 | Create compressor module | `src/offload/compressor.ts` | Wrap `createL3TokenCounter()`, `buildTiktokenContextSnapshot()`, `compressByScoreCascade()`, `aggressiveCompressUntilBelowThreshold()`, `emergencyCompress()`, `populateOffloadLookupMap()` |
| 2.2 | Call `configureTokenTracker()` at startup | `src/offload/compressor.ts` | Call `configureTokenTracker("o200k_base")` once before any snapshot. This sets the tiktoken encoding (default `o200k_base`). Without this, the encoder may use wrong encoding or fail to initialize. |
| 2.3 | Implement token estimation | `src/offload/compressor.ts` | Initialize `js-tiktoken` encoder; `estimateMessageTokens(messages)` wrapping `buildTiktokenContextSnapshot()`. Uses per-message WeakMap cache internally for performance. |
| 2.4 | Implement compression orchestrator | `src/offload/compressor.ts` | `compressSession(messages, offloadEntries, config)` → applies mild/aggressive/emergency based on thresholds |
| 2.5 | Wire compression into `beforeTurn()` | `src/offload/index.ts` | Read offload entries → populate lookup map → estimate tokens → apply compression → return modified messages |
| 2.6 | Handle the no-op case | `src/offload/index.ts` | If no offload entries exist (no tool calls), `offloadMap` is empty → mild compression is no-op → fall through to aggressive/emergency |
| 2.3 | Implement compression orchestrator | `src/offload/compressor.ts` | `compressSession(messages, offloadEntries, config)` → applies mild/aggressive/emergency based on thresholds |
| 2.4 | Wire compression into `beforeTurn()` | `src/offload/index.ts` | Read offload entries → populate lookup map → estimate tokens → apply compression → return modified messages |
| 2.5 | Handle the no-op case | `src/offload/index.ts` | If no offload entries exist (no tool calls), `offloadMap` is empty → mild compression is no-op → fall through to aggressive/emergency |

### Key Algorithm Flow

```typescript
async function compressBeforeTurn(
  messages: ChatMessage[],
  offloadEntries: OffloadEntry[],
  config: OffloadConfig,
  stateManager: OffloadStateManager,
): Promise<ChatMessage[]> {
  // 1. Build lookup map from existing L1 entries
  const offloadMap = populateOffloadLookupMap(offloadEntries);

  // 2. Estimate current token usage
  const snap = buildTiktokenContextSnapshot("l3_before_turn", messages, null, null);
  const contextWindow = config.contextWindow;

  // 3. Determine compression tier
  const mildThreshold = Math.floor(contextWindow * config.mildOffloadRatio);
  const aggressiveThreshold = Math.floor(contextWindow * config.aggressiveCompressRatio);
  const emergencyThreshold = Math.floor(contextWindow * config.emergencyCompressRatio);

  // 4. Emergency: last resort before LLM call
  if (snap.totalTokens >= emergencyThreshold) {
    // Will target emergencyTargetRatio of context window
    const targetTokens = Math.floor(contextWindow * config.emergencyTargetRatio);
    const countTokens = createL3TokenCounter(config, logger);
    return emergencyCompress(messages, targetTokens, countTokens, null, null, logger);
  }

  // 5. Aggressive: delete oldest messages
  if (snap.totalTokens >= aggressiveThreshold) {
    const countTokens = createL3TokenCounter(config, logger);
    const sysPrompt = extractSystemPrompt(messages);
    // aggressiveCompressUntilBelowThreshold() mutates messages in-place
    await aggressiveCompressUntilBelowThreshold(
      messages, offloadMap, new Set(), config.aggressiveDeleteRatio,
      stateManager, logger, aggressiveThreshold, countTokens, sysPrompt, null,
    );
  }

  // 6. Mild: replace tool results with L1 summaries
  if (snap.totalTokens >= mildThreshold && offloadMap.size > 0) {
    compressByScoreCascade(
      messages, offloadMap, new Set(), config.mildOffloadScanRatio, logger,
    );
  }

  return messages;
}
```

### Dependencies
- Phase 1 complete (storage exists to read offload entries)
- npm packages: `js-tiktoken`, `ai`, `@ai-sdk/openai` must be installed (see Phase 0 setup)

### Validation
- Unit test: token estimation with known message arrays
- Unit test: compression orchestrator with mocked token counter (deterministic)
- Unit test: each tier triggers at correct thresholds
- Manual: send 30-turn conversation, verify history is trimmed
- `bun test src/offload/compressor.test.ts` passes

---

## Phase 3: OffloadService Implementation + Wiring (Estimated: 1 session)

### Goal
Complete the `OffloadService` class with real storage, state management, and compression. Wire into `ChatService`.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 3.1 | Implement `OffloadService` state lifecycle | `src/offload/index.ts` | Per-user `OffloadStateManager` init, session switching, save/load |
| 3.2 | Implement `beforeTurn()` | `src/offload/index.ts` | Load user context → read entries → compress → inject MMD (if L2 enabled) |
| 3.3 | Implement `afterTurn()` | `src/offload/index.ts` | Save state.json |
| 3.4 | Implement `close()` | `src/offload/index.ts` | Save all sessions, clear timers |
| 3.5 | Wire into `ChatService.replyToUser()` | `src/services/chat-service.ts` | Call `beforeTurn()` before prompt build; call `afterTurn()` after reply |
| 3.6 | Add `onToolCallResult` callback to ChatClient | `src/openai/chat-client.ts` | Optional callback after each tool execution; needed for L1 capture in Phase 4 |

### ChatService Integration Points

```typescript
class ChatService {
  private offloadService?: OffloadService;

  async replyToUser(user: User, text: string): Promise<string> {
    // 1. Recall from TDAI
    const recalled = await this.memory.recall(userKey, text);

    // 2. Offload compression (BEFORE prompt build)
    if (this.offloadService) {
      messages = await this.offloadService.beforeTurn({
        userKey,
        userText: text,
        previousMessages: messages,
      });
    }

    // 3. Build prompt (uses compressed messages)
    const prompt = this.promptBuilder.build({
      systemPrompt,
      messages,
      recalledMemories: recalled,
      availableTools,
    });

    // 4. Chat with tool loop
    const reply = await this.chatClient.reply({
      messages: prompt.messages,
      availableTools,
      onToolCallResult: this.offloadService
        ? (toolName, toolCallId, params, result) =>
            this.offloadService!.onToolCall({ userKey, toolName, toolCallId, params, result })
        : undefined,
    });

    // 5. Offload after-turn (save state)
    if (this.offloadService) {
      await this.offloadService.afterTurn({ userKey });
    }

    // 6. TDAI capture
    await this.memory.capture(userKey, text, reply);

    return reply;
  }
}
```

### Dependencies
- Phase 2 complete (compressor exists)
- Phase 1 complete (storage exists)
- Phase 0 complete (skeleton exists)

### Validation
- `bun test src/services/chat-service.test.ts` passes
- `bun test src/offload/index.test.ts` passes (unit test skeleton)
- Manual: bot starts, sends message, shuts down cleanly with offload enabled
- `bun check` passes

---

## Phase 4: L1 Tool Pair Capture (Estimated: 1 session)

### Goal
Buffer tool call/result pairs during the tool loop and flush them to L1 summarized entries via `LocalLlmClient`.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 4.1 | Create LLM client wrapper | `src/offload/llm-client.ts` | Wrap library `LocalLlmClient` with bot's env (`env.baseUrl`, `env.apiKey`, `env.model`). Export `createLocalLlmClient()` factory |
| 4.2 | Implement tool pair buffer | `src/offload/index.ts` | `onToolCall()` calls `stateManager.addToolPair({ toolName, toolCallId, params, result, timestamp })` to buffer (uses public API, not private `pendingToolPairs` field) |
| 4.3 | Implement L1 flush in `afterTurn()` | `src/offload/index.ts` | Call `LocalLlmClient.l1Summarize()` on buffered pairs; write entries via `appendOffloadEntries()` |
| 4.4 | Handle L1 fallback | `src/offload/index.ts` | On LLM failure: write degraded entries (truncated raw text, no summary) after 3 retries |
| 4.5 | Add L1 config guard | `src/offload/index.ts` | Only flush when `config.l1Enabled === true` and tool pairs exist |
| 4.6 | Verify prompt compatibility | Manual: compare OpenAI tool call format vs library's expected format | The library's `l1-prompt.ts` expects `toolPairs: [{ toolName, toolCallId, params, result }]`. OpenAI function calling uses `tool_calls[{ id, function: { name, arguments } }]`. Compatible if we map correctly. |

### LLM Client Setup

```typescript
import { LocalLlmClient } from "TencentDB-Agent-Memory/src/offload/local-llm/index.ts";

function createLlClient(env: AppEnv): LocalLlmClient {
  return new LocalLlmClient(
    {
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model: env.offloadModel || env.model,  // Use separate model if configured
      temperature: env.offloadTemperature,
      timeoutMs: 30_000,
    },
    loggerAdapter,
  );
}
```

### Dependencies
- Phase 3 complete (OffloadService exists, ChatClient callback exists)
- Phase 1 complete (storage to write L1 entries)

### Risk: Prompt Format Mismatch
The library's L1 summarization prompt in `local-llm/prompts/l1-prompt.ts` formats tool pairs as:

```text
Tool calls to summarize (newest first):
[Call abc123] search_files({path: "src/"})
Result:
[Tool result] Found 12 files...

[Call def456] read_file({path: "src/index.ts"})
Result:
[Tool result] Content: import ... from ...
```

If the bot's OpenAI tool call format differs (e.g., function name vs tool name, params as JSON string vs object), we must adapt the prompt template or write a format adapter. Likely compatible with minor mapping.

### Validation
- Unit test: tool pair buffering and flush
- Unit test: L1 entry writing to JSONL
- Integration: send message triggering tool call, verify `data/memory-tdai/offload/telegram-bot/offload-{id}.jsonl` contains entries
- `bun test` passes

---

## Phase 5: L3 Compression — Full Integration (Estimated: 0.5 session)

### Goal
With L1 entries now being written (Phase 4), mild compression can actually replace tool results with summaries. This phase connects L1 → L3: mild compression uses L1 entries for replacement.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 5.1 | Wire offload entries into compressor | `src/offload/index.ts` → `beforeTurn()` | Read L1 entries → populate offloadMap → pass to compressor |
| 5.2 | Verify mild compression works with real L1 data | Manual test | Send message with tool call → L1 entry created → subsequent turn compresses old tool result |
| 5.3 | Add compression stats logging | `src/offload/compressor.ts` | Log tokens before/after, tier applied, replaced/deleted counts |

### Dependencies
- Phase 4 complete (L1 entries exist in storage)
- Phase 2 complete (compressor exists)

### Critical: Tool Call ID Format Adapter

Before mild compression works, messages must be in the format the library expects. The L3 helpers look for:
- `msg.toolCallId` or `msg.message?.toolCallId` on tool result messages
- `block.id` where `block.type === "tool_use"` in assistant messages

OpenAI's format uses:
- `msg.tool_calls[i].id` on assistant messages (NOT on tool results)
- `msg.role === "tool"` for tool results (not `"toolResult"`)

**Mitigation:** Implement a `normalizeMessages()` adapter in `compressor.ts` that:
1. Copies `tool_calls[i].id` into a `toolCallId` field on the matching tool result message
2. Marks assistant messages with tool_calls as `type: "message"` with proper `message.toolCallId`
3. Maps `role: "tool"` to `role: "toolResult"` if needed

See spec §11.4 for full field mapping table.

### Validation
- Manual: verify old tool results are replaced with `[summary: ...]` style messages after mild compression threshold is reached
- `bun test` passes

---

## Phase 6: L1.5 Task Boundary Detection (Estimated: 1 session — optional)

### Goal
After L1 flush, determine if the user's current activity crosses a task boundary. Enables task tracking across multi-turn conversations.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 6.1 | Implement L1.5 judgment in `afterTurn()` | `src/offload/index.ts` | After L1 flush, call `LocalLlmClient.l15Judge()` with recent history |
| 6.2 | Apply task transition | `src/offload/index.ts` | Import `handleTaskTransition()` from library; push boundary to state manager |
| 6.3 | Handle L1.5 failures gracefully | `src/offload/index.ts` | On failure: set boundary to "short", clear active MMD, set l15Settled=true (fail-safe) |
| 6.4 | Add L1.5 guard | `src/offload/index.ts` | Only run when `config.l15Enabled === true` |

### L1.5 Request Format

```typescript
const resp = await llmClient.l15Judge({
  recentMessages: buildRecentHistory(messages, currentPrompt),
  currentMmd: activeMmd ? { filename, content, path } : null,
  availableMmdMetas: await listAvailableMmds(ctx),
});

// judgment response
{
  taskCompleted: boolean;
  isContinuation: boolean;
  continuationMmdFile?: string;
  newTaskLabel?: string;
  isLongTask: boolean;
}
```

### Dependencies
- Phase 4 complete (L1 entries exist)
- Phase 1 complete (storage + MMD file I/O)

### Risk
L1.5 prompts reference OpenClaw concepts — may need adaptation if the LLM produces incorrect judgments with OpenClaw-free context.

### Validation
- Unit test: L1.5 judgment with known task-switch patterns (mocked LLM)
- Manual: send messages across two distinct tasks, verify boundary pushed correctly
- `bun test` passes

---

## Phase 7: L2 MMD Generation (Estimated: 1 session — optional)

### Goal
Generate Mermaid flowchart files tracking task progress. Injected into context for task-aware conversations.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 7.1 | Create L2 scheduler | `src/offload/scheduler.ts` | `setTimeout`-based polling; checks null entry count >= `l2NullThreshold` and last L2 > `l2TimeoutSeconds` ago |
| 7.2 | Wire into `OffloadService` | `src/offload/index.ts` | Start scheduler in `afterTurn()` if L2 enabled; stop in `close()` |
| 7.3 | Implement MMD generation | `src/offload/index.ts` | Call `LocalLlmClient.l2Generate()` with new entries + existing MMD content; write result via `writeMmd()` |
| 7.4 | Implement MMD injection in `beforeTurn()` | `src/offload/index.ts` | After compression, call `injectMmdIntoMessages()` from library to inject active MMD into messages |
| 7.5 | Backfill node_ids | `src/offload/index.ts` | After L2 completes, call `markOffloadStatus()` to update `node_id` on stored entries |
| 7.6 | Add L2 guard | `src/offload/index.ts` | Only run when `config.l2Enabled === true` and active MMD exists |

### L2 Scheduler Lifecycle

```typescript
class OffloadService {
  private l2Timer: ReturnType<typeof setTimeout> | null = null;
  private l2Running = false;

  private scheduleL2Check(): void {
    if (this.l2Timer || !this.config.l2Enabled) return;

    const check = async () => {
      if (this.l2Running) {
        this.l2Timer = setTimeout(check, 10_000);
        return;
      }

      const ctx = createStorageContext(...);
      const nullCount = (await readAllOffloadEntries(ctx))
        .filter(e => e.node_id === null).length;

      if (nullCount >= this.config.l2NullThreshold) {
        this.l2Running = true;
        try {
          await this.runL2Generation(ctx);
        } finally {
          this.l2Running = false;
        }
      }

      this.l2Timer = setTimeout(check, 10_000);
    };

    this.l2Timer = setTimeout(check, 10_000);
  }

  private stopL2Scheduler(): void {
    if (this.l2Timer) {
      clearTimeout(this.l2Timer);
      this.l2Timer = null;
    }
    this.l2Running = false;
  }
}
```

### MMD Injection in Messages

```typescript
// In beforeTurn(), after compression:
if (this.config.l2Enabled && stateManager.isMmdInjectionReady()) {
  await injectMmdIntoMessages(
    messages,
    stateManager,
    logger,
    () => this.config.contextWindow,
    { mmdMaxTokenRatio: this.config.mmdMaxTokenRatio },
  );
}
```

### Dependencies
- Phase 6 complete (L1.5 creates MMD boundaries)
- Phase 4 complete (L1 entries provide data for L2)
- Phase 1 complete (MMD file I/O)

### Validation
- Unit test: L2 scheduler trigger conditions
- Unit test: MMD write + read + inject round-trip
- Manual: generate 5+ tool calls across 2 tasks, verify MMD files created in `mmds/` directory
- Manual: verify MMD is injected into message array as `_mmdContextMessage` entry
- `bun test` passes

---

## Phase 8: Data Retention Cleanup (Estimated: 0.5 session — optional)

### Goal
Prevent unbounded disk growth from offload JSONL and ref files.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 8.1 | Schedule reclaim timer | `src/offload/index.ts` | If `offloadRetentionDays >= 3`, call `reclaimOffloadData()` every 24h via `setInterval` |
| 8.2 | Clean up on shutdown | `src/offload/index.ts` | Clear reclaim timer in `close()` |
| 8.3 | Add cleanup guard | `src/offload/index.ts` | Skip when `offloadRetentionDays < 3` (matches library behavior) |

### Reclaim Configuration

```typescript
import { reclaimOffloadData } from "TencentDB-Agent-Memory/src/offload/reclaimer.ts";

// In afterTurn() or at startup:
if (config.offloadRetentionDays >= 3) {
  const reclaimInterval = setInterval(async () => {
    const stats = await reclaimOffloadData(dataRoot, {
      retentionDays: config.offloadRetentionDays,
      logMaxSizeMb: 50,
    }, logger);
    logger.info(`[offload] reclaim: ${stats.deletedJsonl} jsonl, ${stats.deletedRefs} refs, ${stats.deletedMmds} mmds`);
  }, 24 * 60 * 60 * 1000);

  // Store reference for cleanup
  this.reclaimTimer = reclaimInterval;
}
```

### Dependencies
- Phase 3+ complete (data is being written)

### Validation
- Unit test: verify `reclaimOffloadData()` is called with correct parameters
- Manual: set retention to 0, verify no cleanup; set to 3, verify cleanup runs
- `bun test` passes

---

## Phase 9: Testing & Polish (Estimated: 1 session)

### Goal
Comprehensive testing, edge cases, and documentation.

### Tasks

| # | Task | Files | Description |
|---|---|---|---|
| 9.1 | Unit tests for `OffloadService` | `src/offload/index.test.ts` | Test lifecycle: init, beforeTurn (with/without compression), afterTurn (with/without tool pairs), close |
| 9.2 | Unit tests for compressor | `src/offload/compressor.test.ts` | Test each compression tier with mocked token counter; test empty offloadMap (no-op mild); test preservation rules (last user message preserved) |
| 9.3 | Unit tests for storage wrapper | `src/offload/storage.test.ts` | Test session key mapping, read/write entries, MMD I/O |
| 9.4 | Unit tests for L1 flush | `src/offload/index.test.ts` | Test tool pair buffer, L1 flush with mocked LLM, fallback on failure, retry logic |
| 9.5 | Edge case tests | Various | No tool calls, empty session, rapid consecutive turns, multi-session, shutdown during L2 poll, disabled offload, enabled offload with no model configured |
| 9.6 | Integration test | Manual E2E | Start bot with offload enabled, send 20+ messages with tool calls, verify: history trimmed at thresholds, MMD files created (if L2 enabled), data persists across restarts |
| 9.7 | Documentation | `README.md` | Document offload env vars, config, expected behavior, compression tiers, storage layout |
| 9.8 | Performance benchmark | Manual | Measure per-turn latency with/without offload; identify bottlenecks in token counting vs compression algorithms |

### Token Counter Mock for Deterministic Tests

```typescript
// Instead of real tiktoken (non-deterministic across environments), mock:
function createMockTokenCounter(): (text: string) => number {
  return (text: string) => Math.ceil(text.length / 2);  // ~2 chars per token
}

// Then pass to compressor functions instead of real counter
```

### Validation
- `bun test` 100% pass on app code (pre-existing submodule failures excluded)
- `bun check` passes
- Manual E2E: bot runs for 50+ turns without context overflow errors
- Manual E2E: shutdown/restart preserves offload state

---

## Phase Summary & Estimation

| Phase | Description | Sessions | Required for MVP |
|---|---|---|---|
| 0 | Config & scaffolding | 1 | ✅ Yes |
| 1 | Storage & state wrappers | 1 | ✅ Yes |
| 2 | Token counter & L3 compressor | 1 | ✅ Yes |
| 3 | OffloadService implementation + wiring | 1 | ✅ Yes |
| 4 | L1 tool pair capture | 1 | ✅ Yes (mild compression) |
| 5 | L3 full integration (mild uses L1 entries) | 0.5 | ✅ Yes |
| **MVP Total** | **Phases 0–5** | **5.5** | |
| 6 | L1.5 task boundary detection | 1 | ❌ Optional |
| 7 | L2 MMD generation + injection | 1 | ❌ Optional |
| 8 | Data retention cleanup | 0.5 | ❌ Optional |
| 9 | Testing & polish | 1 | ✅ Yes |
| **Full Total** | **Phases 0–9** | **8–9** | |

**MVP delivers:** L3 context compression (prevents context overflow) + L1 tool pair summarization (provides data for mild compression). No L1.5, L2, or retention.

---

## Key Files to Create

```
src/offload/
├── index.ts              ← OffloadService class
├── types.ts              ← OffloadConfig + library type re-exports
├── storage.ts            ← Storage wrapper (dir paths, I/O)
├── state-manager.ts      ← OffloadStateManager wrapper
├── compressor.ts         ← L3 compression orchestrator
├── llm-client.ts         ← LocalLlmClient wrapper
├── scheduler.ts          ← L2 polling scheduler (Phase 7+)
├── index.test.ts         ← Unit tests
├── compressor.test.ts    ← Compressor tests
└── storage.test.ts       ← Storage tests
```

---

## Key Files to Modify

| File | Changes |
|---|---|
| `src/config/env.ts` | +8 offload env vars |
| `src/config/env.test.ts` | +8 assertions |
| `src/memory/build-memory-config.ts` | +offload section |
| `src/main.ts` | OffloadService instantiation |
| `src/services/chat-service.ts` | Optional offloadService param + hook calls |
| `src/openai/chat-client.ts` | Optional onToolCallResult callback |

---

## Risk & Dependencies Matrix

| Risk | Affected Phases | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Library `storage.ts` uses ESM imports with `.js` extensions — Bun resolves them but Windows paths may differ | 1 | Low | Medium | Test import resolution on Windows during Phase 1 |
| `js-tiktoken` native addon may fail under Bun | 2 | Low | High (no token counting) | Implement char-count fallback (`createL3TokenCounter` has built-in); test on first run |
| `ai` + `@ai-sdk/openai` packages must be direct deps | 0 | Low | High (LLM calls fail) | Pin versions in `package.json`; verify imports at startup |
| L1/L1.5/L2 prompts produce poor quality with standalone format vs OpenClaw context | 4, 6, 7 | Medium | Medium | Adapt prompts if needed; start with conservative L1 only (simplest prompt) |
| L1/L1.5/L2 prompts produce poor quality with standalone format vs OpenClaw context | 4, 6, 7 | Medium | Medium | Adapt prompts if needed; start with conservative L1 only (simplest prompt) |
| L3 compression deletes messages the user wanted to keep | 2, 3 | Low-Medium | High (UX) | Last user message always preserved; conservative defaults; easy to disable |
| Offload LLM calls increase API cost | 4, 6, 7 | Medium | Low-Medium | Use cheaper model for offload; offload disabled by default; L1 configurable frequency |
| `OffloadContextEngine` is 500+ lines — by skipping it we must replicate orchestration | 3 | Low | Low | Only orchestration logic is: read entries → compress → inject MMD. Simple sequencing. |

---

## Decision Points

| # | Decision | Options | Recommended | Rationale |
|---|---|---|---|---|
| 1 | **MVP scope** | L3 only vs L3+L1 vs full | **L3 + L1 (Phases 0–5)** | L3 needs L1 for mild compression. L1.5/L2 are additive. |
| 2 | **Storage path** | `data/memory-tdai/offload/` vs `data/offload/` | **`data/memory-tdai/offload/`** | Co-located with TDAI memory data; single data root for cleanup |
| 3 | **Separate model for offload** | Use main model vs `OFFLOAD_MODEL` | **Configurable** | Default to main model; allow override for cheaper model |
| 4 | **L1 summarization model** | `gpt-4o-mini` (current) vs cheaper | **Use configured model** | Current model is already `gpt-4o-mini` — cheap enough |
| 5 | **L2 polling interval** | 10s / 30s / 60s | **Start at 30s** | Less aggressive than library's 10s; lower CPU for standalone bot |
