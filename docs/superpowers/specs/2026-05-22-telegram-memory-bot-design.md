# Telegram memory bot design

Date: 2026-05-22

## Goal

Build a local-first Telegram bot with `grammy` that chats as an AI assistant, remembers each user over time, stores runtime data under `data/`, and integrates with the vendored `TencentDB-Agent-Memory` package **without editing anything inside `TencentDB-Agent-Memory/`**.

## Approved constraints

- The bot must run locally first.
- Runtime data must live under `data/`.
- The bot should use `grammy`.
- The bot should support normal AI chat on text messages, not only memory commands.
- Long-term memory is keyed **per Telegram user**, not per chat.
- V1 only needs to handle **text messages**.
- Access control uses **one-time verification codes only**.
- Verification is required once per Telegram user; after successful redemption, that user may keep chatting without re-verifying.
- One-time codes are generated **per user on first contact** and written to local logs.
- The implementation must not edit source files under `TencentDB-Agent-Memory/`.
- V1 uses **OpenAI only** for both chat generation and TencentDB memory embeddings.
- V1 must configure an explicit embedding model for TencentDB memory so recall can use vector-aware search instead of keyword-only fallback.
- Bun is the preferred runtime target, but memory integration must be isolated so a different integration path can be swapped in later if Bun compatibility is incomplete.

## Recommended architecture

### Top-level shape

The application is split into six focused parts:

1. **Telegram runtime**
   - Owns the `grammy` bot instance, long polling startup, graceful shutdown, and update routing.
   - Applies middleware in this order: logging, auth gate, helper context injection, main handlers.

2. **Verification service**
   - Issues one active code for a new Telegram user.
   - Logs the code locally with Telegram user metadata.
   - Validates submitted codes.
   - Permanently marks users as verified after one successful redemption.

3. **Authorization store**
   - Stores pending codes and verified users under `data/auth/`.
   - Is fully owned by this app and independent from TencentDB memory internals.

4. **LLM client**
   - Wraps the OpenAI chat client configured from environment variables.
   - Produces the assistant reply from the current message plus recalled memory.

5. **Tencent memory adapter**
   - Wraps the vendored TencentDB package behind a local interface.
   - Handles recall before reply and capture after reply.
   - Keeps the rest of the app unaware of TencentDB internal APIs.

6. **Compatibility boundary**
   - Contains any Bun-specific glue, bootstrap code, or patch workflow needed for the vendored package.
   - Must live in this app, or in a patch process outside the vendor directory, never as direct edits under `TencentDB-Agent-Memory/`.

### Why this shape

The approved direction is **direct import through an adapter**, not a gateway sidecar. Because the vendored package is not being edited and may expose mostly host-oriented internals, the app should isolate those imports behind one adapter. This keeps the rest of the bot stable even if the memory integration needs to change later.

## Data model and storage

### Local directories

All app-owned runtime state lives under `data/`.

Recommended layout:

```text
data/
  auth/
    pending-codes.json
    verified-users.json
  memory-tdai/
    ...TencentDB memory data...
  logs/
    verification.log
```

### Verification records

`pending-codes.json` stores one active code per Telegram user:

- `telegramUserId`
- `username`
- `firstName`
- `issuedAt`
- `expiresAt`
- `codeHash`
- `attemptCount`

`verified-users.json` stores permanent authorization status:

- `telegramUserId`
- `username`
- `firstName`
- `verifiedAt`
- `firstSeenAt`
- `lastSeenAt`

### Memory keys

Each user gets one stable memory identity:

```text
tg:user:<telegram_user_id>
```

This key is used for every recall and capture call so the same person keeps the same memory across private chats or future chat locations.

## Message flow

### 1. Unverified user flow

1. A Telegram user sends a text message.
2. The bot checks `verified-users.json`.
3. If the user is not verified, the verification service checks `pending-codes.json`.
4. If there is no active valid code, the bot generates a new one, stores only its hash, and writes the plaintext code to local logs.
5. The bot replies with a short instruction asking the user to send their verification code.
6. The user sends the code.
7. The bot validates the submitted code for that Telegram user only.
8. While a pending code exists, every text message from that user is treated as a code submission attempt.
9. On success, the user is moved to `verified-users.json`, the pending code is deleted, and the bot confirms access.
10. The code can never be reused.

### 2. Verified user chat flow

1. A verified user sends a text message.
2. The bot computes the memory key `tg:user:<id>`.
3. The Tencent memory adapter performs recall for that key.
4. The bot builds the model prompt from:
   - the current user message,
   - recalled memory,
   - optional system instructions.
5. The LLM client generates the reply.
6. The bot sends the reply to Telegram.
7. The Tencent memory adapter captures the turn using the same memory key.

## Verification design

### Code generation

- Generate a fresh code on first contact for each unknown user.
- Codes are bound to one Telegram user ID.
- Only one active code may exist per user at a time.
- A new code invalidates the previous one.

### Code lifetime

- Codes expire after **15 minutes**.
- If the user retries after expiry, the bot generates and logs a new code.

### One-time redemption

- A code is deleted immediately after a successful match.
- Verified users never need to redeem again for this local bot data set.
- Verification fails closed if auth state cannot be persisted.

### Log output

The verification service logs enough context for the operator to identify the user safely:

- Telegram user ID
- username if available
- first name if available
- issued timestamp
- expiry timestamp
- plaintext verification code

The bot should not echo the code back in chat after generation.

## TencentDB memory integration

### Integration rule

Do not modify `TencentDB-Agent-Memory/`. Integration happens only through app code.

### Adapter responsibilities

The adapter should expose a small local interface such as:

- `initialize(dataDir)`
- `recall(userKey, query)`
- `capture(userKey, userText, assistantText, metadata)`

Internally it may import vendored TypeScript files directly, but only from app-owned code.

### Data root

TencentDB memory data should be rooted at:

```text
data/memory-tdai/
```

### Embedding model configuration

The vendored package's user-facing config path expects an explicit **remote OpenAI-compatible embedding provider** when embedding-backed recall is enabled. For V1, the bot should configure TencentDB memory with an **OpenAI-only** embedding setup:

- `storeBackend: "sqlite"`
- `recall.strategy: "hybrid"`
- `embedding.provider: "openai"`
- `embedding.baseUrl`
- `embedding.apiKey`
- `embedding.model`
- `embedding.dimensions`

This means the app should not rely on implicit Bun-local embedding behavior just because the vendored code is TypeScript. The adapter should build an explicit memory config for hybrid recall so vector search is available from the start.

### Compatibility policy

Because Bun compatibility is desired but not guaranteed, the adapter must be the only place that knows TencentDB internals. If the direct-import path fails later, the adapter can be replaced without restructuring handlers, auth, or provider code.

If a compatibility fix is needed, use one of these patterns without editing vendor source:

- app-owned bootstrap shim;
- app-owned wrapper module;
- patch artifact stored outside `TencentDB-Agent-Memory/` and applied as part of setup.

## Runtime and configuration

### Target runtime

- Preferred target: **Bun**.
- The design assumes Bun runs the bot process.
- Compatibility with the vendored memory code is validated at startup.

### Environment variables

The bot continues using the existing `.env.example` shape and expands it as needed. The app should map env values into an in-memory config object that follows the relevant parts of `TencentDB-Agent-Memory/openclaw.plugin.json`.

Current inputs already present:

- `BOT_TOKEN`
- `MEMORY_AGENT`
- `PROVIDER`
- `BASE_URL`
- `MODEL`

V1 should add explicit TencentDB embedding inputs:

- `EMBEDDING_BASE_URL`
- `EMBEDDING_API_KEY`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`

Recommended meaning for V1:

- `BOT_TOKEN`: Telegram bot token.
- `MEMORY_AGENT`: base local storage root, expected to point at `data/`; the TencentDB adapter stores memory under `path.join(MEMORY_AGENT, "memory-tdai")`.
- `PROVIDER`: fixed to `openai` in V1.
- `BASE_URL`: OpenAI chat API base URL.
- `MODEL`: OpenAI chat model identifier.
- `EMBEDDING_BASE_URL`: OpenAI embedding API base URL.
- `EMBEDDING_API_KEY`: OpenAI embedding API key.
- `EMBEDDING_MODEL`: OpenAI embedding model identifier used by TencentDB memory.
- `EMBEDDING_DIMENSIONS`: embedding vector size expected by the memory store.

The adapter should convert these env values into the TencentDB memory config shape, including `embedding.provider: "openai"`. Because the vendored package disables embedding when these fields are absent or incomplete, V1 should treat embedding configuration as part of the required memory setup rather than an optional tuning step.

## Error handling

### Startup

Fail fast during startup if any of the following are missing or broken:

- `BOT_TOKEN`
- required chat model configuration
- required embedding model configuration
- auth storage initialization
- TencentDB adapter initialization

The bot must not start in a partially functional state.

### Verification errors

- Wrong code: reply with a short invalid-code message.
- Expired code: issue and log a replacement code.
- Reused code: reject it.
- Auth store write failure: reject verification.

### Chat errors

- LLM failure: reply with a short temporary error message.
- Memory recall failure: continue the chat without recalled memory.
- Memory capture failure: log the failure after sending the reply.

### Logging

The app should log at least:

- verification code issuance;
- verification success and failure reason;
- startup configuration failures;
- recall/capture failures;
- model call failures.

## Testing strategy

### Unit tests

1. Verification code issuance per Telegram user.
2. Code expiry after 15 minutes.
3. Single-use redemption behavior.
4. Permanent verified-user storage.
5. Stable memory key generation: `tg:user:<id>`.

### Adapter tests

1. Recall happens before reply generation.
2. Capture happens after a successful reply.
3. Adapter initialization uses `data/memory-tdai/`.
4. Adapter failure surfaces cleanly at startup.

### Integration test

Run one local end-to-end flow with real `grammy` long polling and local `data/` storage:

1. New user sends message.
2. Bot logs a code.
3. User redeems the code.
4. User sends a normal text message.
5. Bot replies.
6. Memory files are created under `data/memory-tdai/`.

## Out of scope for V1

- group-chat specific behavior;
- image, voice, file, or OCR memory capture;
- multi-admin approval workflows;
- editing TencentDB vendor sources;
- remote deployment or distributed storage;
- switching to a gateway sidecar unless direct import proves unworkable.

## Implementation guidance

Keep files small and responsibilities explicit:

- auth logic should not know model details;
- Telegram handlers should not know TencentDB internals;
- the adapter should be the only layer that imports vendored memory code;
- all writes to auth files should be atomic.

This keeps the direct-import approach maintainable while preserving a clean fallback path if Bun and the vendored package disagree at runtime.
