# TencentDB memory v2 local-first design

Date: 2026-05-22
Status: Approved design

## Summary

Adapt the app so it fully uses the vendored `TencentDB-Agent-Memory` package as the memory engine, with a zero-config local default based on `SQLite + sqlite-vec`. The app should stop requiring remote embedding configuration for startup. Remote embeddings remain supported as an optional add-on through a redesigned memory-specific environment namespace.

## Goals

- Make local `SQLite + sqlite-vec` the default memory mode with no required embedding environment variables.
- Treat `TencentDB-Agent-Memory` as the authoritative memory agent for config parsing, storage behavior, recall, extraction, deduplication, and degradation behavior.
- Redesign the app-level memory environment contract to be memory-scoped and v2-aligned.
- Keep remote embedding support available as an explicit optional upgrade path.
- Minimize app-owned memory config so the vendored parser remains the source of truth for defaults.
- Preserve the stable Telegram session key format.

## Non-goals

- Preserve backward compatibility for the old `MEMORY_AGENT` or `EMBEDDING_*` variable names.
- Re-implement TencentDB v2 defaults in app code.
- Introduce new app-level tuning knobs for settings that already have suitable upstream defaults.
- Replace the vendored TencentDB memory implementation with a separate in-app memory stack.

## Current mismatch

The current app configuration hard-requires remote embedding settings in `src/config/env.ts`, while the vendored TencentDB v2 stack is designed to run with zero-config local `SQLite + sqlite-vec` by default. The current `src/memory/build-memory-config.ts` also hardcodes a broad set of memory defaults, which creates drift from `TencentDB-Agent-Memory/src/config.ts` and prevents the app from fully deferring to the vendored memory agent.

## Architecture

The final design keeps three layers with strict ownership boundaries:

1. `src/config/env.ts`
   - Parse app runtime configuration.
   - Parse `MEMORY_ROOT`.
   - Parse an optional memory embedding block only when explicitly configured.

2. `src/memory/build-memory-config.ts`
   - Build a minimal raw config object for TencentDB v2.
   - Set only app-specific intent.
   - Omit fields that already have correct upstream defaults.

3. `src/memory/tencent-memory-adapter.ts`
   - Pass the raw config through `parseConfig(...)` from the vendored TencentDB package.
   - Initialize `TdaiCore` and delegate capture and recall to it.

This keeps the app thin and lets the vendored memory engine own the behavior that belongs to memory itself.

## Environment contract

### App runtime env that stays app-owned

- `BOT_TOKEN`
- `PROVIDER`
- `OPENAI_API_KEY`
- `BASE_URL`
- `MODEL`

These continue to describe the primary chat runtime.

### Memory env redesign

Replace the current mixed app-level memory and embedding shape with a memory-scoped namespace:

- `MEMORY_ROOT`
- `MEMORY_EMBEDDING_PROVIDER`
- `MEMORY_EMBEDDING_BASE_URL`
- `MEMORY_EMBEDDING_API_KEY`
- `MEMORY_EMBEDDING_MODEL`
- `MEMORY_EMBEDDING_DIMENSIONS`

### Parsed shape

`AppEnv` should expose:

- app runtime settings
- `memoryRoot`
- an optional `memoryEmbedding` object

If `MEMORY_EMBEDDING_PROVIDER` is absent or set to `none`, the memory embedding object is omitted and the app runs in local SQLite mode without remote embedding requirements.

If `MEMORY_EMBEDDING_PROVIDER` is present with a remote provider value, the parsed env includes a `memoryEmbedding` object that is passed through to TencentDB config building. Inside that object, the non-provider fields are parsed as optional pass-through values so the app does not duplicate TencentDB’s remote-embedding completeness rules.

## Integration boundary

The vendored `TencentDB-Agent-Memory` package is the actual memory agent. The app integration should be limited to the following responsibilities:

### App-owned responsibilities

- resolve the memory data root
- build the stable Telegram session key
- pass the main runtime LLM settings into `StandaloneHostAdapter`
- call capture and recall via the existing adapter interface

### TencentDB-owned responsibilities

- config parsing and default resolution
- SQLite + `sqlite-vec` lifecycle
- BM25, FTS, vector, and hybrid recall behavior
- extraction and deduplication behavior
- scene and persona pipeline behavior
- degraded-mode and fallback logic
- Bun SQLite compatibility behavior already covered by the existing Bun compatibility test

The app must not maintain a second source of truth for memory behavior.

## Data flow and ownership of defaults

Startup and runtime flow should work like this:

1. `parseEnv(...)` resolves app config, `MEMORY_ROOT`, and the optional memory embedding block.
2. `buildTdaiRawConfig(...)` produces a minimal raw TencentDB config.
3. `parseConfig(...)` in the vendored package resolves defaults.
4. `TdaiCore` uses the resolved config for initialization and runtime behavior.
5. Adapter methods continue to forward `recall()` and `capture()` into TencentDB core.

The design rule is:

> The app should not restate TencentDB defaults unless it is intentionally overriding them.

As a result, the app should remove most of the current hardcoded blocks in `src/memory/build-memory-config.ts` for capture, extraction, persona, pipeline, recall, BM25, and embedding defaults.

## Raw config mapping

The raw config produced by `src/memory/build-memory-config.ts` should be minimal, but this spec should still define the exact object shapes the app is allowed to emit.

### Local-only default raw config

When no remote memory embedding is configured, the app should build exactly this raw config:

```ts
{
  storeBackend: "sqlite",
}
```

This is the default app behavior. TencentDB v2 then resolves the rest of the memory behavior from its own parser defaults.

### Optional remote-embedding raw config

When remote memory embedding is explicitly configured, the app should build this raw config shape:

```ts
{
  storeBackend: "sqlite",
  embedding: {
    provider: "<remote-provider>",
    baseUrl: "<openai-compatible-base-url>",
    apiKey: "<api-key>",
    model: "<embedding-model>",
    dimensions: <positive-integer>,
  },
}
```

In concrete TypeScript terms, the builder is allowed to emit only these fields:

- `storeBackend`
- `embedding.provider`
- `embedding.baseUrl`
- `embedding.apiKey`
- `embedding.model`
- `embedding.dimensions`

No other embedding defaults should be restated in app code.

### Builder rules

`buildTdaiRawConfig(...)` should follow these rules:

1. Always set `storeBackend: "sqlite"`.
2. Add no `embedding` key at all when memory embedding is not configured.
3. Add the `embedding` object only when `MEMORY_EMBEDDING_PROVIDER` is set to a remote provider value.
4. Pass through only the configured memory embedding values from app env.
5. Do not synthesize app-owned defaults for TencentDB memory subsystems.

### Omit by default

The app should omit the following unless it later has a strong product reason to override them:

- `capture`
- `extraction`
- `persona`
- `pipeline`
- `recall`
- `bm25`
- `llm`
- `offload`
- `report`
- `tcvdb`

TencentDB v2 already provides defaults for these areas, and this app is explicitly choosing the SQLite-backed path rather than owning those subsystem settings itself.

## Recall behavior

The app should rely on TencentDB v2’s existing behavior when embeddings are unavailable.

- Local zero-config mode uses SQLite storage and keyword-capable recall via upstream behavior.
- If recall strategy remains `hybrid` upstream, TencentDB v2 already falls back to keyword when embedding services are unavailable.
- The app does not need to add its own keyword fallback logic.

This keeps degradation behavior centralized in the vendored memory agent.

## Error handling

The app should validate only fields it truly owns.

- `src/config/env.ts` validates app runtime config and the structural shape of memory-specific env values.
- The app should not duplicate TencentDB’s completeness rules for remote embeddings.
- `src/memory/build-memory-config.ts` should pass through only the memory embedding fields that were actually configured.
- `TencentDB-Agent-Memory/src/config.ts` remains responsible for interpreting incomplete or disabled embedding configuration and degrading cleanly.

This avoids conflicting validation behavior between the app and the vendored package.

## Verification strategy

Update tests so they prove the new ownership model.

### Env tests

Update `src/config/env.test.ts` to cover:

- zero-config local memory mode
- optional memory embedding block present
- provider absent behavior
- provider `none` behavior

### Raw config tests

Update `src/memory/build-memory-config.test.ts` to cover:

- minimal local-first raw config output
- no unnecessary hardcoded v1-style default blocks
- optional embedding pass-through when configured

### Adapter/runtime smoke tests

Keep `src/memory/bun-sqlite-compat.test.ts` as the Bun + SQLite compatibility smoke test.

Add an adapter-level smoke test for `src/memory/tencent-memory-adapter.ts` that verifies the memory agent initializes in local mode without any remote embedding configuration.

## Migration

The app-level migration is intentional and breaking at the environment-variable level.

### Rename and replace

- `MEMORY_AGENT` is replaced by `MEMORY_ROOT`
- old `EMBEDDING_*` variables are replaced by `MEMORY_EMBEDDING_*`

### No backward-compat aliases

No aliases should be added for the old names. The redesign should be clean and explicit.

### Documentation updates

Repo docs and examples should show the new local-first configuration so the default setup matches TencentDB v2 behavior.

## Scope boundaries for implementation

This design is focused enough for a single implementation plan. The implementation should be limited to:

- app env parsing changes
- raw config builder simplification
- adapter initialization validation through tests
- related docs and test updates needed to reflect the new contract

It should not expand into unrelated TencentDB internals or broader bot runtime refactors.

## Acceptance criteria

The change is complete when all of the following are true:

- The app starts without any remote embedding environment variables.
- The app uses local TencentDB SQLite storage by default.
- `src/memory/build-memory-config.ts` no longer duplicates broad TencentDB defaults.
- Optional remote memory embeddings can be enabled only through the new `MEMORY_EMBEDDING_*` namespace.
- Existing memory capture and recall entrypoints continue to work through `TencentMemoryAdapter`.
- Tests cover local-first startup and optional embedding configuration.
- Repo docs/examples reflect the new memory env contract.
