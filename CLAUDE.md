# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## Project Overview

This is a Bun/TypeScript Telegram chat agent. It uses:

- `grammy` for Telegram long polling and message handling.
- OpenAI-compatible chat completions through `src/openai/chat-client.ts`.
- `TencentDB-Agent-Memory/` as a vendored memory engine.
- Local JSON files under `data/` for auth, logs, memory, and offload state.
- Optional offload/context-compression layers for long conversations.

The root app is intentionally small glue code around Telegram, auth, chat,
memory recall/capture, memory search tools, and offload compression.

## Important Constraints

- Do not edit source files inside `TencentDB-Agent-Memory/` unless the user
  explicitly asks for upstream/library work. Treat it as vendored code.
- Keep root app changes scoped to `src/`, `test/`, `tests/`, `docs/`, scripts,
  or config files as appropriate.
- Do not commit `.env`, runtime logs, generated memory data, or other secrets.
- The app is OpenAI-only in this version and text-only for Telegram chat.
- Use Bun commands for normal development. The package has both lockfiles, but
  scripts are Bun-oriented.

## Common Commands

Install dependencies:

```bash
bun install
```

Run the bot in development:

```bash
bun run index.ts
```

Run with watch mode:

```bash
bun run dev
```

Build:

```bash
bun run build
```

Run unit tests:

```bash
bun test ./src/**/*.test.ts
```

or:

```bash
bun run test
```

Run production-style tests:

```bash
bun run test:prod
```

Run offload-specific tests:

```bash
bun test src/offload/
```

Run offload benchmark:

```bash
bun scripts/offload-benchmark.ts
```

## Runtime Setup

Create local env config from the example:

```bash
cp .env.example .env
```

Required core settings include:

- `BOT_TOKEN`
- `PROVIDER=openai`
- `OPENAI_API_KEY`
- `BASE_URL`
- `MODEL`
- embedding settings used by the memory adapter

Runtime data is stored under the configured `MEMORY_AGENT` root, defaulting to
`data/`.

Important generated locations:

- Auth state: `data/auth/pending-codes.json`,
  `data/auth/verified-users.json`
- Verification logs: `data/logs/<yyyy-mm-dd>-verification.log`
- TDAI memory: `data/memory-tdai/`
- Offload state: `data/memory-tdai/offload/telegram-bot/`

## Architecture Map

- `index.ts`: top-level Bun entrypoint, calls `start()`.
- `src/main.ts`: dependency wiring, env parsing, logging, memory, tools,
  offload, chat service, Telegram bot, and shutdown handling.
- `src/config/env.ts`: Zod-based environment parsing. Add new env vars here
  and update `.env.example` and `README.md` when behavior is user-facing.
- `src/telegram/`: Telegram bot setup and text handler.
- `src/auth/`: verification code flow and JSON-backed auth store.
- `src/services/chat-service.ts`: per-user history management and LRU tracking.
- `src/agent/context-agent.ts`: per-turn pipeline: L4 command handling,
  memory recall, offload before/after hooks, LLM call, capture.
- `src/openai/chat-client.ts`: OpenAI-compatible chat client and tool loop.
- `src/prompt/`: prompt assembly.
- `src/memory/`: adapter and config bridge into `TencentDB-Agent-Memory/`.
- `src/tools/`: memory search tools exposed to the LLM.
- `src/offload/`: context compression, L1/L1.5/L2 integration, state, storage,
  local LLM client, and tests.
- `src/logging/`: console and JSONL loggers.
- `src/utils/`: path and JSON file helpers.

## Chat and Memory Flow

1. Telegram receives a text message in `src/telegram/handler.ts`.
2. Unverified users go through `VerificationService`.
3. Verified messages call `ChatService.replyToUser()`.
4. `ChatService` resolves the per-user history and session key.
5. `ContextAgent` tries `/create-skill`, recalls memory, runs offload
   `beforeTurn()`, builds the prompt, calls the LLM, runs offload `afterTurn()`,
   and captures the completed turn into memory.
6. The in-memory chat history is capped by `ChatService.MAX_HISTORY`.

Memory tools available to the model:

- `tdai_memory_search`
- `tdai_conversation_search`

The tools share a per-turn call limit enforced in `ToolHandler`.

## Offload Notes

Offload is optional and controlled by `OFFLOAD_ENABLED`.

- L3 compression works without an extra LLM call.
- L1, L1.5, L2, and L4 skill generation require an offload model. If
  `OFFLOAD_MODEL` is not set, `src/main.ts` falls back to `MODEL`.
- `OFFLOAD_CONTEXT_WINDOW` must match the active model's real context window.
- Offload data is persisted under the memory data root, not in process memory.
- `OffloadService.close()` must be called on shutdown so session state is saved.

When changing offload behavior, prefer focused tests in `src/offload/*.test.ts`
and integration coverage in `src/offload/integration.test.ts` for lifecycle
changes.

## Coding Conventions

- TypeScript is strict. Keep types explicit at module boundaries.
- Use ESM imports with `.ts` extensions, matching existing files.
- Prefer dependency injection as used by `src/main.ts` and service classes.
- Keep side effects at the edges: Telegram, filesystem, OpenAI, and memory
  engine calls should remain behind adapters/services.
- Handle failures in memory recall/capture/offload as non-fatal where the
  existing pipeline does so. User replies should not fail just because memory
  capture or recall failed.
- Use the existing `Logger` shape from `TencentDB-Agent-Memory/src/core/types.ts`
  when adding services.
- Keep runtime directories and file paths centralized through
  `src/utils/paths.ts`.
- Do not introduce broad refactors while fixing a narrow behavior.

## Testing Guidance

For most changes, run the nearest focused test first, then the relevant suite:

```bash
bun test src/<area>/<file>.test.ts
bun run test
```

For env/config changes, run:

```bash
bun test src/config/env.test.ts
bun test src/memory/build-memory-config.test.ts
```

For Telegram/auth changes, run:

```bash
bun test src/telegram/handler.test.ts
bun test src/auth/
```

For OpenAI/tool-loop changes, run:

```bash
bun test src/openai/chat-client.test.ts
bun test src/tools/tool-handler.test.ts
bun test src/services/chat-service.test.ts
```

For offload changes, run:

```bash
bun test src/offload/
```

If tests require network credentials or real Telegram/OpenAI services, do not
run them blindly. Prefer mocked/unit tests unless the user asks for production
verification.

## Documentation Updates

Update `README.md` when changing:

- setup or run commands
- env variables or defaults
- verification flow
- memory/offload behavior visible to operators
- storage layout

Update `docs/plans/` or `docs/specs/` for larger design changes that need a
durable implementation record.
