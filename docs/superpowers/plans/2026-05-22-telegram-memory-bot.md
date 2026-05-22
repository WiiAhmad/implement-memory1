# Telegram Memory Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun-based Telegram bot with grammY and OpenAI that verifies each Telegram user once with a single-use code, stores runtime state under `data/`, and remembers each verified user through TencentDB Agent Memory without editing `TencentDB-Agent-Memory/`.

**Architecture:** Keep the app in small layers: env/config bootstrap, auth persistence + verification service, a TencentDB adapter that directly imports vendored TypeScript entry points, an OpenAI chat client plus chat orchestration service, and a thin grammY handler/runtime layer. The bot process stays in Bun, but all TencentDB-specific logic is isolated behind one adapter so the runtime boundary can be swapped later if Bun and the vendored package disagree.

**Tech Stack:** Bun, TypeScript, grammY, OpenAI SDK, TencentDB Agent Memory internals, zod, Bun test, Node `fs/promises` + `crypto`

---

## File Structure

- `index.ts` — tiny root entrypoint that delegates to `src/main.ts`
- `src/main.ts` — startup/shutdown wiring for env, logger, directories, services, and bot lifecycle
- `src/config/env.ts` — parses `.env` into a strict OpenAI-only app config
- `src/config/env.test.ts` — env parsing tests
- `src/utils/paths.ts` — computes `data/` subpaths and creates directories
- `src/utils/json-file.ts` — atomic JSON read/write helpers for auth state
- `src/logging/console-logger.ts` — app logger matching the TencentDB logger shape
- `src/auth/types.ts` — auth record/result types
- `src/auth/auth-store.ts` — JSON persistence for pending codes and verified users
- `src/auth/verification-service.ts` — one-time code issue/redeem logic and log writing
- `src/auth/verification-service.test.ts` — verification service tests
- `src/memory/types.ts` — local memory adapter interfaces
- `src/memory/build-memory-config.ts` — maps env values into the raw TencentDB config shape from `openclaw.plugin.json`
- `src/memory/build-memory-config.test.ts` — config mapping + session key tests
- `src/memory/tencent-memory-adapter.ts` — direct-import wrapper around `StandaloneHostAdapter`, `parseConfig`, and `TdaiCore`
- `src/openai/chat-client.ts` — OpenAI chat wrapper
- `src/services/chat-service.ts` — recall → OpenAI → capture orchestration
- `src/services/chat-service.test.ts` — orchestration tests
- `src/telegram/handler.ts` — pure text-message handler used by grammY
- `src/telegram/handler.test.ts` — handler tests with fake contexts
- `src/telegram/bot.ts` — grammY bot construction, middleware, `/start`, error handling
- `.env.example` — safe placeholder env template for OpenAI chat + embedding
- `.gitignore` — ignore local `data/` runtime output
- `package.json` — add `start`, `dev`, and `test` scripts
- `README.md` — local run instructions and verification flow

## Task 1: Bootstrap env parsing, runtime paths, and safe local config

**Files:**
- Create: `src/config/env.ts`
- Create: `src/config/env.test.ts`
- Create: `src/utils/paths.ts`
- Create: `src/logging/console-logger.ts`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Write the failing env/parser test**

```ts
// src/config/env.test.ts
import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env.ts";

describe("parseEnv", () => {
  test("parses OpenAI chat and embedding settings", () => {
    const env = parseEnv({
      BOT_TOKEN: "123456:telegram-token",
      MEMORY_AGENT: "data",
      PROVIDER: "openai",
      OPENAI_API_KEY: "sk-chat",
      BASE_URL: "https://api.openai.com/v1",
      MODEL: "gpt-4o-mini",
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "sk-embed",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_DIMENSIONS: "1536",
    });

    expect(env.provider).toBe("openai");
    expect(env.memoryRoot).toBe("data");
    expect(env.baseUrl).toBe("https://api.openai.com/v1");
    expect(env.embedding.model).toBe("text-embedding-3-small");
    expect(env.embedding.dimensions).toBe(1536);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: FAIL with `Cannot find module './env.ts'` or `parseEnv is not defined`.

- [ ] **Step 3: Write the minimal env, path, and logger implementation**

```ts
// src/config/env.ts
import { z } from "zod";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  MEMORY_AGENT: z.string().min(1).default("data"),
  PROVIDER: z.literal("openai"),
  OPENAI_API_KEY: z.string().min(1),
  BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  MODEL: z.string().min(1),
  EMBEDDING_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive(),
});

export interface AppEnv {
  botToken: string;
  memoryRoot: string;
  provider: "openai";
  openAIApiKey: string;
  baseUrl: string;
  model: string;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
}

export function parseEnv(input: Record<string, string | undefined>): AppEnv {
  const parsed = EnvSchema.parse(input);

  return {
    botToken: parsed.BOT_TOKEN,
    memoryRoot: parsed.MEMORY_AGENT,
    provider: parsed.PROVIDER,
    openAIApiKey: parsed.OPENAI_API_KEY,
    baseUrl: parsed.BASE_URL,
    model: parsed.MODEL,
    embedding: {
      baseUrl: parsed.EMBEDDING_BASE_URL,
      apiKey: parsed.EMBEDDING_API_KEY,
      model: parsed.EMBEDDING_MODEL,
      dimensions: parsed.EMBEDDING_DIMENSIONS,
    },
  };
}
```

```ts
// src/utils/paths.ts
import fs from "node:fs/promises";
import path from "node:path";

export interface AppPaths {
  root: string;
  authDir: string;
  logsDir: string;
  memoryDir: string;
  pendingCodesFile: string;
  verifiedUsersFile: string;
  verificationLogFile: string;
}

export function resolveDataPaths(memoryRoot: string): AppPaths {
  const root = path.resolve(memoryRoot);
  const authDir = path.join(root, "auth");
  const logsDir = path.join(root, "logs");
  const memoryDir = path.join(root, "memory-tdai");

  return {
    root,
    authDir,
    logsDir,
    memoryDir,
    pendingCodesFile: path.join(authDir, "pending-codes.json"),
    verifiedUsersFile: path.join(authDir, "verified-users.json"),
    verificationLogFile: path.join(logsDir, "verification.log"),
  };
}

export async function ensureRuntimeDirectories(paths: AppPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.authDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
}
```

```ts
// src/logging/console-logger.ts
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

function format(level: string, message: string): string {
  return `${new Date().toISOString()} [telegram-bot] ${level} ${message}`;
}

export function createLogger(): Logger {
  return {
    debug: (message) => console.debug(format("DEBUG", message)),
    info: (message) => console.info(format("INFO", message)),
    warn: (message) => console.warn(format("WARN", message)),
    error: (message) => console.error(format("ERROR", message)),
  };
}
```

- [ ] **Step 4: Run the env test to verify it passes**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: PASS with `1 pass`.

- [ ] **Step 5: Update runtime scripts and local env templates, then commit**

```json
// package.json
{
  "name": "agent",
  "module": "index.ts",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run index.ts",
    "dev": "bun --watch index.ts",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  },
  "dependencies": {
    "@grammyjs/conversations": "^2.1.1",
    "@grammyjs/parse-mode": "^2.3.0",
    "grammy": "^1.43.0",
    "openai": "^6.39.0",
    "zod": "^4.4.3"
  }
}
```

```dotenv
# .env.example
BOT_TOKEN=123456789:telegram-bot-token
MEMORY_AGENT=data
PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-key
BASE_URL=https://api.openai.com/v1
MODEL=gpt-4o-mini
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=sk-your-openai-key
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

```gitignore
# .gitignore
# dependencies (bun install)
node_modules

# output
out
dist
*.tgz

# code coverage
coverage
*.lcov

# logs
logs
*.log
report.*.*.*.*.json

# local runtime data
data/

# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# caches
.eslintcache
.cache
*.tsbuildinfo

# IntelliJ based IDEs
.idea

# Finder (MacOS) folder config
.DS_Store
```

Run:

```bash
git add package.json .env.example .gitignore src/config/env.ts src/config/env.test.ts src/utils/paths.ts src/logging/console-logger.ts
git commit -m "chore: bootstrap bot runtime config"
```

Expected: commit created with no runtime files under `data/` staged.

### Task 2: Build verification persistence and one-time code logic

**Files:**
- Create: `src/utils/json-file.ts`
- Create: `src/auth/types.ts`
- Create: `src/auth/auth-store.ts`
- Create: `src/auth/verification-service.ts`
- Create: `src/auth/verification-service.test.ts`

- [ ] **Step 1: Write the failing verification tests**

```ts
// src/auth/verification-service.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDataPaths, ensureRuntimeDirectories } from "../utils/paths.ts";
import { JsonAuthStore } from "./auth-store.ts";
import { VerificationService } from "./verification-service.ts";

const identity = {
  telegramUserId: "42",
  username: "terry",
  firstName: "Terry",
};

describe("VerificationService", () => {
  test("first contact issues a pending code and does not verify yet", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bot-auth-"));
    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);
      const store = new JsonAuthStore(paths);
      const logLines: string[] = [];
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        generateCode: () => "112233",
        appendLog: async (line) => {
          logLines.push(line);
        },
      });

      const result = await service.handleUnverifiedInput(identity, "hello");

      expect(result.kind).toBe("awaiting_code");
      expect(await store.isVerified(identity.telegramUserId)).toBe(false);
      expect(logLines[0]).toContain("112233");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("matching code verifies once and deletes the pending record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bot-auth-"));
    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);
      const store = new JsonAuthStore(paths);
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        generateCode: () => "112233",
      });

      await service.handleUnverifiedInput(identity, "hello");
      const verified = await service.handleUnverifiedInput(identity, "112233");

      expect(verified.kind).toBe("verified");
      expect(await store.isVerified(identity.telegramUserId)).toBe(true);
      expect(await store.getPending(identity.telegramUserId)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expired codes are replaced with a fresh one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bot-auth-"));
    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);
      const store = new JsonAuthStore(paths);
      let now = new Date("2026-05-22T10:00:00.000Z");
      let nextCode = "112233";
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        now: () => now,
        generateCode: () => nextCode,
      });

      await service.handleUnverifiedInput(identity, "hello");
      now = new Date("2026-05-22T10:16:00.000Z");
      nextCode = "445566";

      const result = await service.handleUnverifiedInput(identity, "112233");
      const pending = await store.getPending(identity.telegramUserId);

      expect(result.kind).toBe("awaiting_code");
      expect(pending?.expiresAt).toBe("2026-05-22T10:31:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the verification test file and confirm it fails**

Run:

```bash
bun test src/auth/verification-service.test.ts
```

Expected: FAIL with missing `JsonAuthStore` / `VerificationService` modules.

- [ ] **Step 3: Write atomic JSON helpers and auth persistence**

```ts
// src/utils/json-file.ts
import fs from "node:fs/promises";
import path from "node:path";

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tempPath, filePath);
}
```

```ts
// src/auth/types.ts
export interface TelegramIdentity {
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
}

export interface PendingVerificationRecord extends TelegramIdentity {
  codeHash: string;
  issuedAt: string;
  expiresAt: string;
  attemptCount: number;
}

export interface VerifiedUserRecord extends TelegramIdentity {
  verifiedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type PendingCodeMap = Record<string, PendingVerificationRecord>;
export type VerifiedUserMap = Record<string, VerifiedUserRecord>;

export type VerificationResult =
  | { kind: "awaiting_code"; expiresAt: string }
  | { kind: "invalid_code"; expiresAt: string }
  | { kind: "verified" };
```

```ts
// src/auth/auth-store.ts
import type { AppPaths } from "../utils/paths.ts";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.ts";
import type {
  PendingCodeMap,
  PendingVerificationRecord,
  VerifiedUserMap,
  VerifiedUserRecord,
} from "./types.ts";

export class JsonAuthStore {
  constructor(private readonly paths: AppPaths) {}

  async getPending(telegramUserId: string): Promise<PendingVerificationRecord | null> {
    const pending = await this.readPendingMap();
    return pending[telegramUserId] ?? null;
  }

  async savePending(record: PendingVerificationRecord): Promise<void> {
    const pending = await this.readPendingMap();
    pending[record.telegramUserId] = record;
    await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
  }

  async deletePending(telegramUserId: string): Promise<void> {
    const pending = await this.readPendingMap();
    delete pending[telegramUserId];
    await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
  }

  async incrementPendingAttempt(telegramUserId: string): Promise<void> {
    const pending = await this.readPendingMap();
    const record = pending[telegramUserId];
    if (!record) return;
    pending[telegramUserId] = {
      ...record,
      attemptCount: record.attemptCount + 1,
    };
    await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
  }

  async isVerified(telegramUserId: string): Promise<boolean> {
    const verified = await this.readVerifiedMap();
    return telegramUserId in verified;
  }

  async saveVerified(record: VerifiedUserRecord): Promise<void> {
    const verified = await this.readVerifiedMap();
    verified[record.telegramUserId] = record;
    await writeJsonFileAtomic(this.paths.verifiedUsersFile, verified);
  }

  private readPendingMap(): Promise<PendingCodeMap> {
    return readJsonFile(this.paths.pendingCodesFile, {} satisfies PendingCodeMap);
  }

  private readVerifiedMap(): Promise<VerifiedUserMap> {
    return readJsonFile(this.paths.verifiedUsersFile, {} satisfies VerifiedUserMap);
  }
}
```

- [ ] **Step 4: Write the verification service and rerun the tests**

```ts
// src/auth/verification-service.ts
import fs from "node:fs/promises";
import { createHash, randomInt } from "node:crypto";
import type { JsonAuthStore } from "./auth-store.ts";
import type {
  PendingVerificationRecord,
  TelegramIdentity,
  VerificationResult,
  VerifiedUserRecord,
} from "./types.ts";

export interface VerificationServiceOptions {
  store: JsonAuthStore;
  verificationLogFile: string;
  now?: () => Date;
  ttlMs?: number;
  generateCode?: () => string;
  appendLog?: (line: string) => Promise<void>;
}

export class VerificationService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly generateCode: () => string;
  private readonly appendLog: (line: string) => Promise<void>;

  constructor(private readonly opts: VerificationServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
    this.generateCode = opts.generateCode ?? (() => String(randomInt(100000, 1000000)));
    this.appendLog =
      opts.appendLog ??
      (async (line: string) => {
        await fs.appendFile(this.opts.verificationLogFile, line + "\n", "utf8");
      });
  }

  async isVerified(telegramUserId: string): Promise<boolean> {
    return this.opts.store.isVerified(telegramUserId);
  }

  async handleUnverifiedInput(identity: TelegramIdentity, input: string): Promise<VerificationResult> {
    const existing = await this.opts.store.getPending(identity.telegramUserId);
    const now = this.now();

    if (!existing || Date.parse(existing.expiresAt) <= now.getTime()) {
      const next = await this.issueCode(identity, now);
      return { kind: "awaiting_code", expiresAt: next.expiresAt };
    }

    if (this.hash(input.trim()) !== existing.codeHash) {
      await this.opts.store.incrementPendingAttempt(identity.telegramUserId);
      return { kind: "invalid_code", expiresAt: existing.expiresAt };
    }

    await this.opts.store.deletePending(identity.telegramUserId);
    const verifiedRecord: VerifiedUserRecord = {
      ...identity,
      verifiedAt: now.toISOString(),
      firstSeenAt: existing.issuedAt,
      lastSeenAt: now.toISOString(),
    };
    await this.opts.store.saveVerified(verifiedRecord);

    return { kind: "verified" };
  }

  private async issueCode(identity: TelegramIdentity, now: Date): Promise<PendingVerificationRecord> {
    const plainCode = this.generateCode();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const record: PendingVerificationRecord = {
      ...identity,
      codeHash: this.hash(plainCode),
      issuedAt: now.toISOString(),
      expiresAt,
      attemptCount: 0,
    };

    await this.opts.store.savePending(record);
    await this.appendLog(
      JSON.stringify({
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        telegramUserId: identity.telegramUserId,
        username: identity.username,
        firstName: identity.firstName,
        verificationCode: plainCode,
      }),
    );

    return record;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
```

Run:

```bash
bun test src/auth/verification-service.test.ts
```

Expected: PASS with `3 pass`.

- [ ] **Step 5: Commit the auth layer**

Run:

```bash
git add src/utils/json-file.ts src/auth/types.ts src/auth/auth-store.ts src/auth/verification-service.ts src/auth/verification-service.test.ts
git commit -m "feat: add one-time verification flow"
```

Expected: commit created with only auth/runtime helper files staged.

### Task 3: Create the TencentDB config mapper and memory adapter

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/build-memory-config.ts`
- Create: `src/memory/build-memory-config.test.ts`
- Create: `src/memory/tencent-memory-adapter.ts`

- [ ] **Step 1: Write the failing config/session-key test**

```ts
// src/memory/build-memory-config.test.ts
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env.ts";
import { buildMemorySessionKey, buildTdaiRawConfig } from "./build-memory-config.ts";

const env: AppEnv = {
  botToken: "123456:telegram-token",
  memoryRoot: "data",
  provider: "openai",
  openAIApiKey: "sk-chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  embedding: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-embed",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
};

describe("buildTdaiRawConfig", () => {
  test("maps OpenAI embedding env into the TencentDB schema shape", () => {
    const raw = buildTdaiRawConfig(env);

    expect(raw.storeBackend).toBe("sqlite");
    expect(raw.recall).toEqual({
      enabled: true,
      maxResults: 5,
      strategy: "hybrid",
      timeoutMs: 5000,
    });
    expect(raw.embedding).toEqual({
      enabled: true,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embed",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
  });

  test("builds the stable Telegram memory session key", () => {
    expect(buildMemorySessionKey(42)).toBe("tg:user:42");
  });
});
```

- [ ] **Step 2: Run the memory config test to verify it fails**

Run:

```bash
bun test src/memory/build-memory-config.test.ts
```

Expected: FAIL with missing `build-memory-config.ts`.

- [ ] **Step 3: Write the config mapper and memory adapter interface**

```ts
// src/memory/types.ts
export interface MemoryRecall {
  prependContext?: string;
  appendSystemContext?: string;
}

export interface MemoryAdapter {
  recall(userKey: string, query: string): Promise<MemoryRecall>;
  capture(userKey: string, userText: string, assistantText: string): Promise<void>;
  close(): Promise<void>;
}
```

```ts
// src/memory/build-memory-config.ts
import type { AppEnv } from "../config/env.ts";

export function buildMemorySessionKey(telegramUserId: number | string): string {
  return `tg:user:${telegramUserId}`;
}

export function buildTdaiRawConfig(env: AppEnv): Record<string, unknown> {
  return {
    storeBackend: "sqlite",
    capture: { enabled: true },
    extraction: {
      enabled: true,
      enableDedup: true,
      maxMemoriesPerSession: 20,
    },
    persona: {
      triggerEveryN: 50,
      maxScenes: 15,
      backupCount: 3,
      sceneBackupCount: 10,
    },
    pipeline: {
      everyNConversations: 5,
      enableWarmup: true,
      l1IdleTimeoutSeconds: 600,
      l2DelayAfterL1Seconds: 10,
      l2MinIntervalSeconds: 900,
      l2MaxIntervalSeconds: 3600,
      sessionActiveWindowHours: 24,
    },
    recall: {
      enabled: true,
      maxResults: 5,
      strategy: "hybrid",
      timeoutMs: 5000,
    },
    embedding: {
      enabled: true,
      provider: "openai",
      baseUrl: env.embedding.baseUrl,
      apiKey: env.embedding.apiKey,
      model: env.embedding.model,
      dimensions: env.embedding.dimensions,
    },
    bm25: {
      enabled: true,
      language: "en",
    },
  };
}
```

- [ ] **Step 4: Write the direct-import TencentDB adapter and rerun the tests**

```ts
// src/memory/tencent-memory-adapter.ts
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { StandaloneHostAdapter } from "../../TencentDB-Agent-Memory/src/adapters/standalone/host-adapter.ts";
import { parseConfig } from "../../TencentDB-Agent-Memory/src/config.ts";
import { TdaiCore } from "../../TencentDB-Agent-Memory/src/core/tdai-core.ts";
import type { AppEnv } from "../config/env.ts";
import type { AppPaths } from "../utils/paths.ts";
import { buildTdaiRawConfig } from "./build-memory-config.ts";
import type { MemoryAdapter, MemoryRecall } from "./types.ts";

export class TencentMemoryAdapter implements MemoryAdapter {
  private constructor(private readonly core: TdaiCore) {}

  static async create(env: AppEnv, paths: AppPaths, logger: Logger): Promise<TencentMemoryAdapter> {
    const hostAdapter = new StandaloneHostAdapter({
      dataDir: paths.memoryDir,
      llmConfig: {
        baseUrl: env.baseUrl,
        apiKey: env.openAIApiKey,
        model: env.model,
        maxTokens: 4096,
        timeoutMs: 120000,
      },
      logger,
      defaultUserId: "telegram-user",
      platform: "telegram",
    });

    const config = parseConfig(buildTdaiRawConfig(env));
    const core = new TdaiCore({ hostAdapter, config });
    await core.initialize();
    return new TencentMemoryAdapter(core);
  }

  async recall(userKey: string, query: string): Promise<MemoryRecall> {
    const result = await this.core.handleBeforeRecall(query, userKey);
    return {
      prependContext: result.prependContext,
      appendSystemContext: result.appendSystemContext,
    };
  }

  async capture(userKey: string, userText: string, assistantText: string): Promise<void> {
    const startedAt = Date.now();
    await this.core.handleTurnCommitted({
      userText,
      assistantText,
      sessionKey: userKey,
      startedAt,
      messages: [
        {
          id: `user-${startedAt}`,
          role: "user",
          content: userText,
          timestamp: startedAt,
        },
        {
          id: `assistant-${startedAt + 1}`,
          role: "assistant",
          content: assistantText,
          timestamp: startedAt + 1,
        },
      ],
    });
  }

  async close(): Promise<void> {
    await this.core.destroy();
  }
}
```

Run:

```bash
bun test src/memory/build-memory-config.test.ts
```

Expected: PASS with `2 pass`.

- [ ] **Step 5: Commit the memory adapter layer**

Run:

```bash
git add src/memory/types.ts src/memory/build-memory-config.ts src/memory/build-memory-config.test.ts src/memory/tencent-memory-adapter.ts
git commit -m "feat: add TencentDB memory adapter"
```

Expected: commit created with no edits inside `TencentDB-Agent-Memory/`.

### Task 4: Add the OpenAI chat client and recall/capture orchestration

**Files:**
- Create: `src/openai/chat-client.ts`
- Create: `src/services/chat-service.ts`
- Create: `src/services/chat-service.test.ts`

- [ ] **Step 1: Write the failing chat-service test**

```ts
// src/services/chat-service.test.ts
import { describe, expect, test } from "bun:test";
import { ChatService } from "./chat-service.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient } from "../openai/chat-client.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("ChatService", () => {
  test("recalls before generating a reply and captures after", async () => {
    const calls: string[] = [];
    const memory: MemoryAdapter = {
      recall: async () => {
        calls.push("recall");
        return {
          prependContext: "Known fact: the user likes short answers.",
          appendSystemContext: "Answer briefly.",
        };
      },
      capture: async () => {
        calls.push("capture");
      },
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async () => {
        calls.push("reply");
        return "Hello again.";
      },
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });
    const result = await service.replyToUser({ telegramUserId: 99, text: "Hi" });

    expect(result).toBe("Hello again.");
    expect(calls).toEqual(["recall", "reply", "capture"]);
  });

  test("falls back to chat without memory when recall throws", async () => {
    const memory: MemoryAdapter = {
      recall: async () => {
        throw new Error("recall unavailable");
      },
      capture: async () => {},
      close: async () => {},
    };

    const chatClient: ChatClient = {
      reply: async ({ userPrompt }) => userPrompt,
    };

    const service = new ChatService({ memory, chatClient, logger: noopLogger });
    const result = await service.replyToUser({ telegramUserId: 7, text: "plain message" });

    expect(result).toBe("plain message");
  });
});
```

- [ ] **Step 2: Run the chat-service test and verify it fails**

Run:

```bash
bun test src/services/chat-service.test.ts
```

Expected: FAIL with missing `chat-service.ts` or `chat-client.ts`.

- [ ] **Step 3: Write the OpenAI chat client**

```ts
// src/openai/chat-client.ts
import OpenAI from "openai";

export interface ChatReplyParams {
  systemPrompt?: string;
  userPrompt: string;
}

export interface ChatClient {
  reply(params: ChatReplyParams): Promise<string>;
}

export class OpenAiChatClient implements ChatClient {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async reply(params: ChatReplyParams): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        ...(params.systemPrompt
          ? [{ role: "system" as const, content: params.systemPrompt }]
          : []),
        { role: "user" as const, content: params.userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned an empty reply");
    }

    return text;
  }
}
```

- [ ] **Step 4: Write the orchestration service and rerun the tests**

```ts
// src/services/chat-service.ts
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { buildMemorySessionKey } from "../memory/build-memory-config.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient } from "../openai/chat-client.ts";

export interface ChatServiceOptions {
  memory: MemoryAdapter;
  chatClient: ChatClient;
  logger: Logger;
}

export class ChatService {
  constructor(private readonly opts: ChatServiceOptions) {}

  async replyToUser(params: { telegramUserId: number; text: string }): Promise<string> {
    const userKey = buildMemorySessionKey(params.telegramUserId);

    let prependContext = "";
    let appendSystemContext = "";

    try {
      const recall = await this.opts.memory.recall(userKey, params.text);
      prependContext = recall.prependContext ?? "";
      appendSystemContext = recall.appendSystemContext ?? "";
    } catch (error) {
      this.opts.logger.warn(
        `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const userPrompt = [prependContext, params.text].filter(Boolean).join("\n\n");
    const reply = await this.opts.chatClient.reply({
      systemPrompt: appendSystemContext || undefined,
      userPrompt,
    });

    try {
      await this.opts.memory.capture(userKey, params.text, reply);
    } catch (error) {
      this.opts.logger.warn(
        `Memory capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return reply;
  }
}
```

Run:

```bash
bun test src/services/chat-service.test.ts
```

Expected: PASS with `2 pass`.

- [ ] **Step 5: Commit the chat orchestration layer**

Run:

```bash
git add src/openai/chat-client.ts src/services/chat-service.ts src/services/chat-service.test.ts
git commit -m "feat: add OpenAI chat orchestration"
```

Expected: commit created with chat logic isolated from Telegram handlers.

### Task 5: Wire grammY handlers and the Bun startup entrypoint

**Files:**
- Create: `src/telegram/handler.ts`
- Create: `src/telegram/handler.test.ts`
- Create: `src/telegram/bot.ts`
- Create: `src/main.ts`
- Modify: `index.ts`

- [ ] **Step 1: Write the failing handler test**

```ts
// src/telegram/handler.test.ts
import { describe, expect, test } from "bun:test";
import { createTextHandler } from "./handler.ts";

function createCtx(text: string) {
  const replies: string[] = [];

  return {
    ctx: {
      from: {
        id: 42,
        username: "terry",
        first_name: "Terry",
      },
      message: { text },
      reply: async (message: string) => {
        replies.push(message);
      },
    },
    replies,
  };
}

describe("createTextHandler", () => {
  test("asks an unverified user for a code", async () => {
    const { ctx, replies } = createCtx("hello");
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => false,
        handleUnverifiedInput: async () => ({
          kind: "awaiting_code" as const,
          expiresAt: "2026-05-22T10:15:00.000Z",
        }),
      },
      chatService: {
        replyToUser: async () => "unused",
      },
    });

    await handler(ctx as never);

    expect(replies[0]).toContain("Verification required");
  });

  test("uses chat for a verified user", async () => {
    const { ctx, replies } = createCtx("How are you?");
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => "I am ready.",
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["I am ready."]);
  });

  test("replies with a temporary error when chat generation fails", async () => {
    const { ctx, replies } = createCtx("How are you?");
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          throw new Error("OpenAI unavailable");
        },
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Temporary error. Please try again in a moment."]);
  });
});
```

- [ ] **Step 2: Run the handler test to confirm it fails**

Run:

```bash
bun test src/telegram/handler.test.ts
```

Expected: FAIL with missing `handler.ts`.

- [ ] **Step 3: Write the pure handler and grammY bot factory**

```ts
// src/telegram/handler.ts
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";

export interface TelegramTextContextLike {
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  message?: {
    text?: string;
  };
  reply(text: string): Promise<unknown>;
}

export function createTextHandler(deps: {
  verificationService: Pick<VerificationService, "isVerified" | "handleUnverifiedInput">;
  chatService: Pick<ChatService, "replyToUser">;
}) {
  return async function handleTextMessage(ctx: TelegramTextContextLike): Promise<void> {
    if (!ctx.from || !ctx.message?.text) return;

    const identity = {
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    };
    const text = ctx.message.text.trim();

    if (await deps.verificationService.isVerified(identity.telegramUserId)) {
      try {
        const reply = await deps.chatService.replyToUser({
          telegramUserId: ctx.from.id,
          text,
        });
        await ctx.reply(reply);
      } catch {
        await ctx.reply("Temporary error. Please try again in a moment.");
      }
      return;
    }

    const result = await deps.verificationService.handleUnverifiedInput(identity, text);

    if (result.kind === "verified") {
      await ctx.reply("Verification complete. You can chat now.");
      return;
    }

    if (result.kind === "invalid_code") {
      await ctx.reply("Invalid code. Check the latest local verification log entry and send the current code again.");
      return;
    }

    await ctx.reply("Verification required. Check the local verification log for your code and send it here within 15 minutes.");
  };
}
```

```ts
// src/telegram/bot.ts
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";
import { createTextHandler } from "./handler.ts";

export function createBot(deps: {
  token: string;
  logger: Logger;
  verificationService: VerificationService;
  chatService: ChatService;
}) {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    deps.logger.info(`update=${ctx.update.update_id}`);
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("Hi. Send any message to begin the one-time verification flow.");
  });

  bot.on(
    "message:text",
    createTextHandler({
      verificationService: deps.verificationService,
      chatService: deps.chatService,
    }),
  );

  bot.catch((error) => {
    const e = error.error;
    if (e instanceof GrammyError) {
      deps.logger.error(`Telegram API error: ${e.description}`);
      return;
    }
    if (e instanceof HttpError) {
      deps.logger.error(`Telegram transport error: ${e.message}`);
      return;
    }
    deps.logger.error(`Unknown bot error: ${e instanceof Error ? e.message : String(e)}`);
  });

  return bot;
}
```

- [ ] **Step 4: Write the Bun startup entrypoint and rerun the handler test**

```ts
// src/main.ts
import OpenAI from "openai";
import { JsonAuthStore } from "./auth/auth-store.ts";
import { VerificationService } from "./auth/verification-service.ts";
import { parseEnv } from "./config/env.ts";
import { createLogger } from "./logging/console-logger.ts";
import { TencentMemoryAdapter } from "./memory/tencent-memory-adapter.ts";
import { OpenAiChatClient } from "./openai/chat-client.ts";
import { ChatService } from "./services/chat-service.ts";
import { ensureRuntimeDirectories, resolveDataPaths } from "./utils/paths.ts";
import { createBot } from "./telegram/bot.ts";

export async function start(): Promise<void> {
  const env = parseEnv(process.env);
  const paths = resolveDataPaths(env.memoryRoot);
  const logger = createLogger();
  await ensureRuntimeDirectories(paths);

  const authStore = new JsonAuthStore(paths);
  const verificationService = new VerificationService({
    store: authStore,
    verificationLogFile: paths.verificationLogFile,
  });

  const memory = await TencentMemoryAdapter.create(env, paths, logger);
  const openai = new OpenAI({
    apiKey: env.openAIApiKey,
    baseURL: env.baseUrl,
  });
  const chatClient = new OpenAiChatClient(openai, env.model);
  const chatService = new ChatService({ memory, chatClient, logger });
  const bot = createBot({
    token: env.botToken,
    logger,
    verificationService,
    chatService,
  });

  const shutdown = async () => {
    bot.stop();
    await memory.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  logger.info("Starting Telegram bot with long polling");
  await bot.start();
}
```

```ts
// index.ts
import { start } from "./src/main.ts";

await start();
```

Run:

```bash
bun test src/telegram/handler.test.ts
```

Expected: PASS with `2 pass`.

- [ ] **Step 5: Commit the Telegram runtime layer**

Run:

```bash
git add src/telegram/handler.ts src/telegram/handler.test.ts src/telegram/bot.ts src/main.ts index.ts
git commit -m "feat: wire Telegram bot runtime"
```

Expected: commit created with grammY startup and graceful shutdown wired.

### Task 6: Finish docs and run the local smoke test

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the README with the real local run instructions**

````md
# agent

## Setup

```bash
bun install
cp .env.example .env
```

Set all OpenAI and Telegram values in `.env` before starting the bot.

## Run

```bash
bun run index.ts
```

## Verification flow

1. A new Telegram user sends any text message.
2. The bot writes a one-time verification code to `data/logs/verification.log`.
3. The user sends that code back in Telegram.
4. After a successful match, the user stays verified for future chats.

## Memory storage

- Auth files: `data/auth/pending-codes.json`, `data/auth/verified-users.json`
- Verification log: `data/logs/verification.log`
- TencentDB memory: `data/memory-tdai/`

## Constraints

- OpenAI only in V1
- Text-only chat in V1
- No source edits inside `TencentDB-Agent-Memory/`
````

- [ ] **Step 2: Run the full automated test suite**

Run:

```bash
bun test
```

Expected: PASS with green output for `src/config/env.test.ts`, `src/auth/verification-service.test.ts`, `src/memory/build-memory-config.test.ts`, `src/services/chat-service.test.ts`, and `src/telegram/handler.test.ts`.

- [ ] **Step 3: Start the bot locally**

Run:

```bash
bun run index.ts
```

Expected: console log containing `Starting Telegram bot with long polling` and no startup crash from missing OpenAI or TencentDB configuration.

- [ ] **Step 4: Manually verify the full auth + memory path**

Manual check:

```text
1. Message the bot from a new Telegram account.
2. Open data/logs/verification.log and copy the newest verificationCode for that Telegram user ID.
3. Send the code back to the bot.
4. Send: "remember that my favorite color is blue".
5. Send: "what is my favorite color?"
6. Confirm the bot answers and that data/memory-tdai/ now contains SQLite and conversation artifacts.
```

Expected:

```text
- The first message does not start AI chat yet.
- The second message with the correct code unlocks the user.
- Follow-up chat succeeds.
- data/auth/verified-users.json contains the Telegram user ID.
- data/memory-tdai/ contains newly created memory files.
```

- [ ] **Step 5: Commit the docs and smoke-tested runtime**

Run:

```bash
git add README.md
git commit -m "docs: add local bot usage guide"
```

Expected: commit created after tests are green and the manual flow has been checked.
