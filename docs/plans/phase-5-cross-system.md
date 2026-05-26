# Phase 5: Cross-System Coordination — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable TDAI memory and offload to benefit from each other without mixing responsibilities. Offload MMDs inform scene importance; scene titles guide MMD naming; persona remains sourced from scenes only.

**Spec reference:** Section 7, 11 (Phase 5)

**Prerequisites:** Phase 2 (memory catch-up triggers), Phase 3 (scene metadata), Phase 4 (offload hardening)

---

## File structure

### Creates or modifies

- Create: `src/services/coordination.ts` — cross-system signal bridge
- Create: `src/services/coordination.test.ts` — tests
- Modify: `src/offload/index.ts` — use scene titles for MMD naming
- Modify: `src/memory/tencent-memory-adapter.ts` — use offload MMD lifecycle for scene resolution
- Modify: `src/prompt/prompt-builder.ts` — inject scene context before offload compression

---

## Task 1: Let completed offload MMDs signal scene resolution

### Step 1: Write failing tests

Create `src/services/coordination.test.ts`:

```ts
describe("CoordinationService", () => {
  test("completed MMD marks resolved scenes with matching title", async () => {
    // MMD completed with label "API Integration Task"
    // Scene titled "API Integration" exists
    // Expected: scene status → "resolved"
  });

  test("does not mark scenes resolved when no matching MMD", async () => {
    // MMD completed with label "Database Setup"
    // Scene titled "API Integration" exists
    // Expected: scene status unchanged
  });
});
```

- [ ] Write test cases
- [ ] Run `bun test src/services/coordination.test.ts` — verify FAIL

### Step 2: Implement coordination service

Create `src/services/coordination.ts`:

```ts
export class CoordinationService {
  constructor(
    private readonly memoryAdapter: TencentMemoryAdapter,
    private readonly offloadService: OffloadService,
    private readonly logger: Logger,
  ) {}

  async onMmdCompleted(sessionKey: string, mmd: MmdDocument): Promise<void> {
    // 1. Extract label/title from MMD
    // 2. Search scenes for matching title (fuzzy match)
    // 3. If match found: mark scene as "resolved"
    // 4. Log: [memory-tdai] [scene] resolved mmd=<label> scene=<title>
  }

  async onMemoryRecall(context: RecallContext): Promise<void> {
    // Before memory recall, check if there are relevant MMD completions
    // that could signal scene resolution
  }
}
```

- [ ] Implement MMD → scene resolution signal
- [ ] Run tests — verify PASS

---

## Task 2: Let scene title guide MMD naming

### Step 1: Write failing tests

Add to `coordination.test.ts`:

```ts
test("L1.5 uses current scene title as MMD label hint", async () => {
  // Current session has active scene "Refactoring Auth"
  // L1.5 judgment runs
  // Expected: scene title is passed as label hint
});

test("falls back to generic label when no active scene", async () => {
  // No scenes exist for session
  // L1.5 judgment runs
  // Expected: no scene hint passed
});
```

- [ ] Write test cases
- [ ] Verify FAIL

### Step 2: Implement scene → MMD naming

In `src/offload/index.ts`, modify L1.5 judgment or MMD creation:

```ts
private async buildMmdContext(sessionKey: string): Promise<MmdContext> {
  // 1. Get active scene for session (from MemoryAutonomyCheckpoint or scene index)
  // 2. If active scene exists, extract title as label hint
  // 3. Pass hint to L1.5 judgment or MMD generation prompt

  const sceneTitle = await this.getActiveSceneTitle(sessionKey);
  return {
    sceneLabel: sceneTitle,
    // ... other context
  };
}
```

- [ ] Implement scene title extraction
- [ ] Pass as hint to L1.5 / MMD generation
- [ ] Run tests — verify PASS

---

## Task 3: Inject persona/scene context into prompt before offload compression

### Step 1: Write failing tests

Add to `coordination.test.ts`:

```ts
test("injects active persona into prompt before offload compression", async () => {
  // Persona exists for session
  // Offload L3 compression runs
  // Expected: persona content is available to L3 for better routing
});

test("injects active scene navigation into prompt", async () => {
  // Active scenes exist
  // Offload L3 compression runs
  // Expected: scene context is injected before compression preserves it
});
```

- [ ] Write test cases
- [ ] Verify FAIL

### Step 2: Implement prompt injection

The injection happens at a specific point in the pipeline to ensure persona/scene context is preserved during offload L3 compression:

**Primary wiring location: `src/agent/context-agent.ts` (the per-turn pipeline orchestrator, step 37a)**

```text
Pipeline order for each turn:
  1. recallMemories()           → loads scenes + persona from TDAI memory
  2. CoordinationService hook   → injects persona/scene context into messages
  3. offload.beforeTurn()       → runs L3 compression (preserves injected context)
  4. buildPrompt()              → assembles final prompt with injected context
  5. callLlm()                  → sends to LLM
```

This ordering is critical: injection happens BETWEEN memory recall and offload compression, so L3 sees the persona/scene context as part of the message stream and preserves it rather than discarding it.

**Secondary location: `src/prompt/prompt-builder.ts`**

```ts
export class PromptBuilder {
  async build(input: PromptInput): Promise<BuiltPrompt> {
    // 1. Build system prompt
    // 2. Inject recalled memories (scene context, persona) — from CoordinationService
    // 3. Inject current task scene title
    // 4. Pass to offload compression (happens before this in context-agent.ts)
  }
}
```

**In `src/offload/index.ts`:**

```ts
async beforeTurn(input: BeforeTurnInput): Promise<ChatMessage[]> {
  // 1. Load active scene context from memory adapter (already injected by CoordinationService)
  // 2. Run L3 compression (preserves already-injected context)
  // 3. Return compressed messages
}
```

- [ ] Implement scene/persona injection hook in context-agent.ts between memory recall and offload beforeTurn
- [ ] Update prompt-builder.ts to consume injected context
- [ ] Run tests — verify PASS

---

## Task 4: Add cross-system metrics

### Step 1: Extend status commands

Modify `/memory-status` to include:

```text
Cross-system:
- Resolved scenes from MMD: N
- MMD names from scenes: N
```

- [ ] Add cross-system metrics to status output
- [ ] Update status tests

### Step 2: Add coordination logs

```text
[coordination] scene resolved mmd=<label> scene=<title>
[coordination] mmd named scene=<title> mmd=<filename>
[coordination] persona injected before compression session=<key>
```

- [ ] Add logs at each coordination point
- [ ] Verify log format matches spec

---

## Task 5: Verify Phase 5 together

- [ ] Run focused tests:

```bash
bun test src/services/coordination.test.ts src/prompt/ src/offload/ src/memory/
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

- [ ] Integration: start bot with all features enabled, verify scene resolution and MMD naming work end-to-end

---

## Self-review

- [ ] MMD → scene resolution does not copy tool outputs into persona
- [ ] Scene → MMD naming uses scene title only, not raw memory content
- [ ] Persona is injected before compression, not duplicated
- [ ] Memory persona is sourced from scenes/memories only, not from offload
- [ ] Cross-system signals are weak — offload never replaces TDAI scene extraction
- [ ] All coordination actions are logged with consistent `[coordination]` prefix
