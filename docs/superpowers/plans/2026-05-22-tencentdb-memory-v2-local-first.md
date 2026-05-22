# TencentDB Memory v2 Local-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the app to a local-first TencentDB v2 memory config that boots with SQLite + sqlite-vec by default, while keeping remote memory embeddings as an optional memory-scoped add-on.

**Architecture:** Keep the app responsible only for parsing app env, mapping optional memory embedding env into a minimal raw TencentDB config, and passing that config to the vendored TencentDB core. Remove app-owned memory defaults so `TencentDB-Agent-Memory/src/config.ts` remains the single source of truth for recall, extraction, and degradation behavior.

**Tech Stack:** Bun, TypeScript, Zod, bun:test, TencentDB-Agent-Memory, SQLite, sqlite-vec

---

## File structure and ownership

- `src/config/env.ts` — app runtime env parser; rename the memory root variable, replace `embedding` with optional `memoryEmbedding`, and keep non-provider embedding fields as optional pass-through values.
- `src/config/env.test.ts` — lock the new local-only default and optional memory embedding behavior with unit tests.
- `src/memory/build-memory-config.ts` — emit only the minimal TencentDB raw config the app truly owns.
- `src/memory/build-memory-config.test.ts` — prove the raw config is local-first by default and only includes `embedding` when memory embedding env is configured.
- `src/memory/tencent-memory-adapter.test.ts` — smoke-test that the vendored TencentDB memory agent initializes in local SQLite mode with no remote embedding config.
- `.env.example` — document the new local-first env contract.

## Scope guardrails

- Do not change `TencentDB-Agent-Memory` internals in this plan.
- Do not add backward-compat aliases for `MEMORY_AGENT` or `EMBEDDING_*`.
- Do not add new app-level tuning knobs for recall, extraction, persona, pipeline, BM25, offload, or report settings.
- Do not modify `src/memory/tencent-memory-adapter.ts` unless the new tests prove the type change alone is insufficient.

### Task 1: Switch env parsing to the new memory-scoped contract

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Replace the `parseEnv` tests with local-first coverage**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../logging/console-logger.ts";
import { ensureRuntimeDirectories, resolveDataPaths } from "../utils/paths.ts";
import { parseEnv } from "./env.ts";

describe("parseEnv", () => {
  test("parses local memory mode without remote embedding config", () => {
    const env = parseEnv({
      BOT_TOKEN: "123456:telegram-token",
      MEMORY_ROOT: "data",
      PROVIDER: "openai",
      OPENAI_API_KEY: "sk-chat",
      BASE_URL: "https://api.openai.com/v1",
      MODEL: "gpt-4o-mini",
    });

    expect(env.botToken).toBe("123456:telegram-token");
    expect(env.memoryRoot).toBe("data");
    expect(env.provider).toBe("openai");
    expect(env.openAIApiKey).toBe("sk-chat");
    expect(env.baseUrl).toBe("https://api.openai.com/v1");
    expect(env.model).toBe("gpt-4o-mini");
    expect(env.memoryEmbedding).toBeUndefined();
  });

  test("parses the optional memory embedding block when provider is set", () => {
    const env = parseEnv({
      BOT_TOKEN: "123456:telegram-token",
      MEMORY_ROOT: "data",
      PROVIDER: "openai",
      OPENAI_API_KEY: "sk-chat",
      BASE_URL: "https://api.openai.com/v1",
      MODEL: "gpt-4o-mini",
      MEMORY_EMBEDDING_PROVIDER: "openai",
      MEMORY_EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      MEMORY_EMBEDDING_API_KEY: "sk-embed",
      MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
      MEMORY_EMBEDDING_DIMENSIONS: "1536",
    });

    expect(env.memoryEmbedding).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embed",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
  });

  test("treats provider none as local-only mode", () => {
    const env = parseEnv({
      BOT_TOKEN: "123456:telegram-token",
      MEMORY_ROOT: "data",
      PROVIDER: "openai",
      OPENAI_API_KEY: "sk-chat",
      BASE_URL: "https://api.openai.com/v1",
      MODEL: "gpt-4o-mini",
      MEMORY_EMBEDDING_PROVIDER: "none",
    });

    expect(env.memoryEmbedding).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the env test file and verify it fails against the old contract**

Run: `bun test src/config/env.test.ts`

Expected: FAIL because `parseEnv(...)` still expects `MEMORY_AGENT` and `EMBEDDING_*`, so the new `MEMORY_ROOT` / `MEMORY_EMBEDDING_*` tests do not pass yet.

- [ ] **Step 3: Replace `src/config/env.ts` with a local-first parser**

```ts
import { z } from "zod";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  MEMORY_ROOT: z.string().min(1).default("data"),
  PROVIDER: z.literal("openai"),
  OPENAI_API_KEY: z.string().min(1),
  BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  MODEL: z.string().min(1),
  MEMORY_EMBEDDING_PROVIDER: z.string().min(1).optional(),
  MEMORY_EMBEDDING_BASE_URL: z.string().url().optional(),
  MEMORY_EMBEDDING_API_KEY: z.string().min(1).optional(),
  MEMORY_EMBEDDING_MODEL: z.string().min(1).optional(),
  MEMORY_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
});

export interface MemoryEmbeddingEnv {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export interface AppEnv {
  botToken: string;
  memoryRoot: string;
  provider: "openai";
  openAIApiKey: string;
  baseUrl: string;
  model: string;
  memoryEmbedding?: MemoryEmbeddingEnv;
}

function buildMemoryEmbedding(parsed: z.infer<typeof EnvSchema>): MemoryEmbeddingEnv | undefined {
  const provider = parsed.MEMORY_EMBEDDING_PROVIDER?.trim();

  if (!provider || provider === "none") {
    return undefined;
  }

  return {
    provider,
    baseUrl: parsed.MEMORY_EMBEDDING_BASE_URL,
    apiKey: parsed.MEMORY_EMBEDDING_API_KEY,
    model: parsed.MEMORY_EMBEDDING_MODEL,
    dimensions: parsed.MEMORY_EMBEDDING_DIMENSIONS,
  };
}

export function parseEnv(input: Record<string, string | undefined>): AppEnv {
  const parsed = EnvSchema.parse(input);

  return {
    botToken: parsed.BOT_TOKEN,
    memoryRoot: parsed.MEMORY_ROOT,
    provider: parsed.PROVIDER,
    openAIApiKey: parsed.OPENAI_API_KEY,
    baseUrl: parsed.BASE_URL,
    model: parsed.MODEL,
    memoryEmbedding: buildMemoryEmbedding(parsed),
  };
}
```

- [ ] **Step 4: Update `.env.example` to show the new zero-config local default**

```env
BOT_TOKEN=123456789:telegram-bot-token
MEMORY_ROOT=data
PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-key
BASE_URL=https://api.openai.com/v1
MODEL=gpt-4o-mini

# Optional: enable remote memory embeddings
# MEMORY_EMBEDDING_PROVIDER=openai
# MEMORY_EMBEDDING_BASE_URL=https://api.openai.com/v1
# MEMORY_EMBEDDING_API_KEY=sk-your-openai-key
# MEMORY_EMBEDDING_MODEL=text-embedding-3-small
# MEMORY_EMBEDDING_DIMENSIONS=1536
```

- [ ] **Step 5: Re-run the env test file and verify it passes**

Run: `bun test src/config/env.test.ts`

Expected: PASS for the three `parseEnv` tests plus the existing `resolveDataPaths` and `createLogger` coverage.

- [ ] **Step 6: Commit the env contract change**

```bash
git add src/config/env.ts src/config/env.test.ts .env.example
git commit -m "refactor: switch memory env contract to local-first v2 names"
```

### Task 2: Make TencentDB raw config minimal and local-first

**Files:**
- Modify: `src/memory/build-memory-config.ts`
- Modify: `src/memory/build-memory-config.test.ts`
- Create: `src/memory/tencent-memory-adapter.test.ts`
- Test: `src/memory/bun-sqlite-compat.test.ts`

- [ ] **Step 1: Replace `src/memory/build-memory-config.test.ts` with minimal-config expectations**

```ts
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env.ts";
import { buildMemorySessionKey, buildTdaiRawConfig } from "./build-memory-config.ts";

const baseEnv: AppEnv = {
  botToken: "123456:telegram-token",
  memoryRoot: "data",
  provider: "openai",
  openAIApiKey: "sk-chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

describe("buildTdaiRawConfig", () => {
  test("builds the local-only SQLite config by default", () => {
    expect(buildTdaiRawConfig(baseEnv)).toEqual({
      storeBackend: "sqlite",
    });
  });

  test("passes through optional memory embedding config", () => {
    expect(
      buildTdaiRawConfig({
        ...baseEnv,
        memoryEmbedding: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-embed",
          model: "text-embedding-3-small",
          dimensions: 1536,
        },
      }),
    ).toEqual({
      storeBackend: "sqlite",
      embedding: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-embed",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
    });
  });

  test("builds the stable Telegram memory session key", () => {
    expect(buildMemorySessionKey(42)).toBe("tg:user:42");
  });
});
```

- [ ] **Step 2: Add a failing adapter smoke test for local SQLite startup**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppEnv } from "../config/env.ts";
import { ensureRuntimeDirectories, resolveDataPaths } from "../utils/paths.ts";
import { TencentMemoryAdapter } from "./tencent-memory-adapter.ts";

const env: AppEnv = {
  botToken: "123456:telegram-token",
  memoryRoot: "data",
  provider: "openai",
  openAIApiKey: "sk-chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("TencentMemoryAdapter.create", () => {
  test("initializes in local SQLite mode without remote embedding config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const adapter = await TencentMemoryAdapter.create(env, paths, noopLogger);

      try {
        expect(adapter).toBeInstanceOf(TencentMemoryAdapter);
      } finally {
        await adapter.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the new memory tests and verify they fail before the builder is simplified**

Run: `bun test src/memory/build-memory-config.test.ts src/memory/tencent-memory-adapter.test.ts`

Expected: FAIL because the old builder still reads `env.embedding.*` and still emits a broad hardcoded TencentDB config instead of the new minimal local-first shape.

- [ ] **Step 4: Replace `src/memory/build-memory-config.ts` with the minimal builder**

```ts
import type { AppEnv } from "../config/env.ts";

export function buildMemorySessionKey(telegramUserId: number | string): string {
  return `tg:user:${telegramUserId}`;
}

export function buildTdaiRawConfig(env: AppEnv): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    storeBackend: "sqlite",
  };

  if (!env.memoryEmbedding) {
    return raw;
  }

  raw.embedding = {
    provider: env.memoryEmbedding.provider,
    ...(env.memoryEmbedding.baseUrl ? { baseUrl: env.memoryEmbedding.baseUrl } : {}),
    ...(env.memoryEmbedding.apiKey ? { apiKey: env.memoryEmbedding.apiKey } : {}),
    ...(env.memoryEmbedding.model ? { model: env.memoryEmbedding.model } : {}),
    ...(env.memoryEmbedding.dimensions ? { dimensions: env.memoryEmbedding.dimensions } : {}),
  };

  return raw;
}
```

- [ ] **Step 5: Run the targeted memory tests and verify they pass**

Run: `bun test src/memory/build-memory-config.test.ts src/memory/tencent-memory-adapter.test.ts src/memory/bun-sqlite-compat.test.ts`

Expected: PASS for the local-only builder test, optional embedding pass-through test, Telegram session key test, adapter local-mode smoke test, and Bun SQLite compatibility smoke test.

- [ ] **Step 6: Commit the minimal TencentDB config change**

```bash
git add src/memory/build-memory-config.ts src/memory/build-memory-config.test.ts src/memory/tencent-memory-adapter.test.ts
git commit -m "refactor: use a minimal local-first TencentDB memory config"
```

### Task 3: Run the final targeted regression sweep

**Files:**
- Test: `src/config/env.test.ts`
- Test: `src/memory/build-memory-config.test.ts`
- Test: `src/memory/tencent-memory-adapter.test.ts`
- Test: `src/memory/bun-sqlite-compat.test.ts`
- Inspect: `.env.example`

- [ ] **Step 1: Run the full targeted regression suite for the env and memory contract**

Run: `bun test src/config/env.test.ts src/memory/build-memory-config.test.ts src/memory/tencent-memory-adapter.test.ts src/memory/bun-sqlite-compat.test.ts`

Expected: PASS with no failing tests in the env or memory files touched by this plan.

- [ ] **Step 2: Inspect the final diff to confirm only the intended contract changes landed**

Run: `git diff -- src/config/env.ts src/config/env.test.ts src/memory/build-memory-config.ts src/memory/build-memory-config.test.ts src/memory/tencent-memory-adapter.test.ts .env.example`

Expected: Diff shows only the env rename, optional `memoryEmbedding` shape, minimal TencentDB raw config builder, new adapter smoke test, and example env updates.

- [ ] **Step 3: Stop here and hand the branch back for review**

At this point the working tree should contain only the planned env + memory changes, and the targeted regression suite should already be green.

## Self-review checklist

- Spec coverage: this plan covers the env rename, the optional memory embedding namespace, the minimal raw config builder, the local SQLite default, the adapter local-mode smoke test, and the example-config update.
- Placeholder scan: no TBD/TODO language remains; every code-changing step includes exact code.
- Type consistency: `memoryEmbedding` is the only memory-embedding name used in the plan, `MEMORY_ROOT` is the only root env key used, and all builder/test snippets use the same `AppEnv` shape.
