# Wallet Telegram Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/wallets-gen`, `/wallets-now`, and `/wallets-privatekey <public-address>` to the Telegram bot with SQLite primary+backup wallet storage and one-time-code private-key reveal.

**Architecture:** Add a focused `src/wallets/` module for generation, storage, command orchestration, and private-key access codes. Wire the module into `src/main.ts`, expose wallet command handlers from `src/telegram/wallet-command-handlers.ts`, and intercept private-key code replies in `src/telegram/handler.ts` before normal chat handling.

**Tech Stack:** Bun, TypeScript ESM, grammY, `@solana/web3.js`, `bip39`, `bs58`, `node:crypto`, `bun:sqlite`, Bun test.

---

## File structure

Create or modify these files:

- Create `src/wallets/types.ts` — shared wallet records and service result types.
- Create `src/wallets/wallet-generator.ts` — Solana wallet generation copied from the reference algorithm without CLI/file side effects.
- Create `src/wallets/wallet-generator.test.ts` — generator shape and no-empty-fields test.
- Create `src/wallets/wallet-store.ts` — SQLite schema, save/list/find/close methods for one DB file.
- Create `src/wallets/wallet-store.test.ts` — in-temp-file store tests.
- Create `src/wallets/wallet-service.ts` — `/wallets-gen` orchestration: generate, save primary, save backup, return public address and backup status.
- Create `src/wallets/wallet-service.test.ts` — primary/backup behavior tests.
- Create `src/wallets/private-key-access-service.ts` — one pending code per Telegram user, daily code logging, code matching/cancel/expiration.
- Create `src/wallets/private-key-access-service.test.ts` — request, success, wrong code, unrelated message, and expiration tests.
- Create `src/telegram/wallet-command-handlers.ts` — testable command handlers for `/wallets-gen`, `/wallets-now`, `/wallets-privatekey`.
- Create `src/telegram/wallet-command-handlers.test.ts` — command reply tests with fake contexts.
- Modify `src/utils/paths.ts` — add wallet directory and DB paths.
- Modify `src/config/env.test.ts` — assert wallet paths and directory creation.
- Modify `src/telegram/handler.ts` — intercept pending private-key code replies before normal verification/chat flow.
- Modify `src/telegram/handler.test.ts` — pending private-key success/cancel tests.
- Modify `src/telegram/bot.ts` — add wallet command handlers and update `/start` command list.
- Modify `src/main.ts` — instantiate stores/services, ensure wallet dirs, pass dependencies, close stores on shutdown.
- Modify `README.md` — document new commands and wallet storage paths.

---

### Task 1: Add wallet runtime paths

**Files:**
- Modify: `src/utils/paths.ts`
- Modify: `src/config/env.test.ts`

- [ ] **Step 1: Write the failing path test**

In `src/config/env.test.ts`, update the `resolveDataPaths` test to include wallet paths. Replace the assertions after `expect(paths.memoryDir)` with this block:

```ts
      expect(paths.memoryDir).toBe(path.join(path.resolve(root), "memory-tdai"));
      expect(paths.walletsDir).toBe(path.join(path.resolve(root), "wallets"));
      expect(paths.walletsDbFile).toBe(path.join(paths.walletsDir, "wallets.sqlite"));
      expect(paths.walletsBackupDbFile).toBe(path.join(paths.walletsDir, "wallets-backup.sqlite"));
      expect(paths.pendingCodesFile).toBe(path.join(paths.authDir, "pending-codes.json"));
      expect(paths.verifiedUsersFile).toBe(path.join(paths.authDir, "verified-users.json"));
      expect(paths.verificationLogFile).toBe(
        path.join(paths.logsDir, "verification.log"),
      );

      await ensureRuntimeDirectories(paths);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: FAIL because `walletsDir`, `walletsDbFile`, and `walletsBackupDbFile` do not exist on `AppPaths`.

- [ ] **Step 3: Implement wallet paths**

Update `src/utils/paths.ts` to this exact content:

```ts
import fs from "node:fs/promises";
import path from "node:path";

export interface AppPaths {
  root: string;
  authDir: string;
  logsDir: string;
  memoryDir: string;
  walletsDir: string;
  pendingCodesFile: string;
  verifiedUsersFile: string;
  verificationLogFile: string;
  walletsDbFile: string;
  walletsBackupDbFile: string;
}

export function resolveDataPaths(memoryRoot: string): AppPaths {
  const projectRoot = path.resolve(import.meta.dir, "..", "..");
  const root = path.isAbsolute(memoryRoot)
    ? memoryRoot
    : path.resolve(projectRoot, memoryRoot);
  const authDir = path.join(root, "auth");
  const logsDir = path.join(root, "logs");
  const memoryDir = path.join(root, "memory-tdai");
  const walletsDir = path.join(root, "wallets");

  return {
    root,
    authDir,
    logsDir,
    memoryDir,
    walletsDir,
    pendingCodesFile: path.join(authDir, "pending-codes.json"),
    verifiedUsersFile: path.join(authDir, "verified-users.json"),
    verificationLogFile: path.join(logsDir, "verification.log"),
    walletsDbFile: path.join(walletsDir, "wallets.sqlite"),
    walletsBackupDbFile: path.join(walletsDir, "wallets-backup.sqlite"),
  };
}

export async function ensureRuntimeDirectories(paths: AppPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.authDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.walletsDir, { recursive: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/paths.ts src/config/env.test.ts
git commit -m "feat: add wallet storage paths"
```

---

### Task 2: Add Solana wallet generator

**Files:**
- Create: `src/wallets/types.ts`
- Create: `src/wallets/wallet-generator.ts`
- Create: `src/wallets/wallet-generator.test.ts`

- [ ] **Step 1: Write the failing generator test**

Create `src/wallets/wallet-generator.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as bip39 from "bip39";
import bs58 from "bs58";
import { generateSolanaWallet } from "./wallet-generator.ts";

describe("generateSolanaWallet", () => {
  test("returns a valid mnemonic, public address, and private key", () => {
    const wallet = generateSolanaWallet();

    expect(bip39.validateMnemonic(wallet.mnemonic)).toBe(true);
    expect(wallet.publicAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(wallet.privateKey).toBeString();
    expect(bs58.decode(wallet.privateKey).length).toBe(64);
  });

  test("generates different addresses on repeated calls", () => {
    const first = generateSolanaWallet();
    const second = generateSolanaWallet();

    expect(first.publicAddress).not.toBe(second.publicAddress);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/wallets/wallet-generator.test.ts
```

Expected: FAIL because `src/wallets/wallet-generator.ts` does not exist.

- [ ] **Step 3: Add shared wallet types**

Create `src/wallets/types.ts`:

```ts
export interface GeneratedWallet {
  mnemonic: string;
  privateKey: string;
  publicAddress: string;
}

export interface WalletRecord extends GeneratedWallet {
  telegramUserId: string;
  createdAt: string;
}

export interface StoredWalletRecord extends WalletRecord {
  id: number;
}

export interface WalletCreationResult {
  publicAddress: string;
  backupSaved: boolean;
}
```

- [ ] **Step 4: Implement generator**

Create `src/wallets/wallet-generator.ts`:

```ts
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import * as bip39 from "bip39";
import bs58 from "bs58";
import type { GeneratedWallet } from "./types.ts";

export function generateSolanaWallet(): GeneratedWallet {
  const mnemonic = bip39.generateMnemonic();
  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const seed = createHash("sha256").update(entropy).digest();
  const keypair = Keypair.fromSeed(seed);

  return {
    mnemonic,
    privateKey: bs58.encode(keypair.secretKey),
    publicAddress: keypair.publicKey.toBase58(),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
bun test src/wallets/wallet-generator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wallets/types.ts src/wallets/wallet-generator.ts src/wallets/wallet-generator.test.ts
git commit -m "feat: add Solana wallet generator"
```

---

### Task 3: Add SQLite wallet store

**Files:**
- Create: `src/wallets/wallet-store.ts`
- Create: `src/wallets/wallet-store.test.ts`

- [ ] **Step 1: Write the failing store test**

Create `src/wallets/wallet-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WalletStore } from "./wallet-store.ts";
import type { WalletRecord } from "./types.ts";

function wallet(overrides: Partial<WalletRecord> = {}): WalletRecord {
  return {
    telegramUserId: "42",
    publicAddress: "Address111111111111111111111111111111111",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    privateKey: "PrivateKey111111111111111111111111111111111",
    createdAt: "2026-05-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("WalletStore", () => {
  test("saves and lists public addresses for one Telegram user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wallet-store-"));
    const store = new WalletStore(path.join(root, "wallets.sqlite"));

    try {
      await store.saveWallet(wallet());
      await store.saveWallet(wallet({
        telegramUserId: "99",
        publicAddress: "Address222222222222222222222222222222222",
      }));

      await expect(store.listPublicAddresses("42")).resolves.toEqual([
        "Address111111111111111111111111111111111",
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds a wallet only for its owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wallet-store-"));
    const store = new WalletStore(path.join(root, "wallets.sqlite"));

    try {
      await store.saveWallet(wallet());

      const owned = await store.findWalletForUser("42", "Address111111111111111111111111111111111");
      const otherUser = await store.findWalletForUser("99", "Address111111111111111111111111111111111");

      expect(owned?.privateKey).toBe("PrivateKey111111111111111111111111111111111");
      expect(otherUser).toBeNull();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/wallets/wallet-store.test.ts
```

Expected: FAIL because `WalletStore` does not exist.

- [ ] **Step 3: Implement SQLite store**

Create `src/wallets/wallet-store.ts`:

```ts
import { Database } from "bun:sqlite";
import type { StoredWalletRecord, WalletRecord } from "./types.ts";

interface WalletRow {
  id: number;
  telegram_user_id: string;
  public_address: string;
  mnemonic: string;
  private_key: string;
  created_at: string;
}

export class WalletStore {
  private readonly db: Database;

  constructor(dbFile: string) {
    this.db = new Database(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT NOT NULL,
        public_address TEXT NOT NULL UNIQUE,
        mnemonic TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wallets_telegram_user_id
      ON wallets (telegram_user_id);
    `);
  }

  async saveWallet(record: WalletRecord): Promise<void> {
    this.db.query(`
      INSERT INTO wallets (
        telegram_user_id,
        public_address,
        mnemonic,
        private_key,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      record.telegramUserId,
      record.publicAddress,
      record.mnemonic,
      record.privateKey,
      record.createdAt,
    );
  }

  async listPublicAddresses(telegramUserId: string): Promise<string[]> {
    const rows = this.db.query(`
      SELECT public_address
      FROM wallets
      WHERE telegram_user_id = ?
      ORDER BY id ASC
    `).all(telegramUserId) as Array<{ public_address: string }>;

    return rows.map((row) => row.public_address);
  }

  async findWalletForUser(
    telegramUserId: string,
    publicAddress: string,
  ): Promise<StoredWalletRecord | null> {
    const row = this.db.query(`
      SELECT id, telegram_user_id, public_address, mnemonic, private_key, created_at
      FROM wallets
      WHERE telegram_user_id = ? AND public_address = ?
      LIMIT 1
    `).get(telegramUserId, publicAddress) as WalletRow | null;

    if (!row) return null;

    return {
      id: row.id,
      telegramUserId: row.telegram_user_id,
      publicAddress: row.public_address,
      mnemonic: row.mnemonic,
      privateKey: row.private_key,
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/wallets/wallet-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallets/wallet-store.ts src/wallets/wallet-store.test.ts
git commit -m "feat: add wallet SQLite store"
```

---

### Task 4: Add wallet creation service with backup writes

**Files:**
- Create: `src/wallets/wallet-service.ts`
- Create: `src/wallets/wallet-service.test.ts`

- [ ] **Step 1: Write failing wallet service tests**

Create `src/wallets/wallet-service.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { WalletService } from "./wallet-service.ts";
import type { GeneratedWallet, WalletRecord } from "./types.ts";

class FakeStore {
  records: WalletRecord[] = [];
  fail = false;

  async saveWallet(record: WalletRecord): Promise<void> {
    if (this.fail) throw new Error("save failed");
    this.records.push(record);
  }

  async listPublicAddresses(telegramUserId: string): Promise<string[]> {
    return this.records
      .filter((record) => record.telegramUserId === telegramUserId)
      .map((record) => record.publicAddress);
  }
}

const generated: GeneratedWallet = {
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "PrivateKey111111111111111111111111111111111",
  publicAddress: "Address111111111111111111111111111111111",
};

describe("WalletService", () => {
  test("saves generated wallet to primary and backup", async () => {
    const primary = new FakeStore();
    const backup = new FakeStore();
    const service = new WalletService({
      primaryStore: primary,
      backupStore: backup,
      generateWallet: () => generated,
      now: () => new Date("2026-05-25T12:00:00.000Z"),
    });

    const result = await service.createWallet("42");

    expect(result).toEqual({
      publicAddress: "Address111111111111111111111111111111111",
      backupSaved: true,
    });
    expect(primary.records).toHaveLength(1);
    expect(backup.records).toEqual(primary.records);
    expect(primary.records[0]).toMatchObject({
      telegramUserId: "42",
      createdAt: "2026-05-25T12:00:00.000Z",
    });
  });

  test("returns backupSaved false when backup write fails after primary succeeds", async () => {
    const primary = new FakeStore();
    const backup = new FakeStore();
    backup.fail = true;
    const logged: string[] = [];
    const service = new WalletService({
      primaryStore: primary,
      backupStore: backup,
      generateWallet: () => generated,
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      logger: { error: (message) => logged.push(message) },
    });

    const result = await service.createWallet("42");

    expect(result.backupSaved).toBe(false);
    expect(primary.records).toHaveLength(1);
    expect(logged[0]).toContain("Wallet backup save failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/wallets/wallet-service.test.ts
```

Expected: FAIL because `WalletService` does not exist.

- [ ] **Step 3: Implement wallet service**

Create `src/wallets/wallet-service.ts`:

```ts
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { generateSolanaWallet } from "./wallet-generator.ts";
import type { GeneratedWallet, WalletCreationResult, WalletRecord } from "./types.ts";
import type { WalletStore } from "./wallet-store.ts";

interface WalletWritableStore {
  saveWallet(record: WalletRecord): Promise<void>;
  listPublicAddresses(telegramUserId: string): Promise<string[]>;
}

interface WalletServiceOptions {
  primaryStore: WalletWritableStore;
  backupStore: Pick<WalletStore, "saveWallet"> | WalletWritableStore;
  generateWallet?: () => GeneratedWallet;
  now?: () => Date;
  logger?: Pick<Logger, "error">;
}

export class WalletService {
  private readonly generateWallet: () => GeneratedWallet;
  private readonly now: () => Date;

  constructor(private readonly options: WalletServiceOptions) {
    this.generateWallet = options.generateWallet ?? generateSolanaWallet;
    this.now = options.now ?? (() => new Date());
  }

  async createWallet(telegramUserId: string): Promise<WalletCreationResult> {
    const wallet = this.generateWallet();
    const record: WalletRecord = {
      ...wallet,
      telegramUserId,
      createdAt: this.now().toISOString(),
    };

    await this.options.primaryStore.saveWallet(record);

    let backupSaved = true;
    try {
      await this.options.backupStore.saveWallet(record);
    } catch (error) {
      backupSaved = false;
      const msg = error instanceof Error ? error.message : String(error);
      this.options.logger?.error(`[wallets] Wallet backup save failed: ${msg}`);
    }

    return {
      publicAddress: record.publicAddress,
      backupSaved,
    };
  }

  async listPublicAddresses(telegramUserId: string): Promise<string[]> {
    return this.options.primaryStore.listPublicAddresses(telegramUserId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/wallets/wallet-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallets/wallet-service.ts src/wallets/wallet-service.test.ts
git commit -m "feat: add wallet creation service"
```

---

### Task 5: Add private-key access service

**Files:**
- Create: `src/wallets/private-key-access-service.ts`
- Create: `src/wallets/private-key-access-service.test.ts`
- Modify: `src/wallets/types.ts`

- [ ] **Step 1: Extend shared types**

Modify `src/wallets/types.ts` to this exact content:

```ts
export interface GeneratedWallet {
  mnemonic: string;
  privateKey: string;
  publicAddress: string;
}

export interface WalletRecord extends GeneratedWallet {
  telegramUserId: string;
  createdAt: string;
}

export interface StoredWalletRecord extends WalletRecord {
  id: number;
}

export interface WalletCreationResult {
  publicAddress: string;
  backupSaved: boolean;
}

export interface TelegramIdentity {
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
}

export type PrivateKeyRequestResult =
  | { kind: "issued"; expiresAt: string }
  | { kind: "not_found" };

export type PrivateKeyConsumeResult =
  | { kind: "none" }
  | { kind: "revealed"; publicAddress: string; privateKey: string }
  | { kind: "canceled"; reason: "wrong_code" | "expired" | "not_found" | "unexpected_message" };
```

- [ ] **Step 2: Write failing private-key access tests**

Create `src/wallets/private-key-access-service.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PrivateKeyAccessService } from "./private-key-access-service.ts";
import type { StoredWalletRecord, TelegramIdentity } from "./types.ts";

const identity: TelegramIdentity = {
  telegramUserId: "42",
  username: "terry",
  firstName: "Terry",
};

const wallet: StoredWalletRecord = {
  id: 1,
  telegramUserId: "42",
  publicAddress: "Address111111111111111111111111111111111",
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "PrivateKey111111111111111111111111111111111",
  createdAt: "2026-05-25T12:00:00.000Z",
};

class FakeWalletReader {
  found: StoredWalletRecord | null = wallet;

  async findWalletForUser(): Promise<StoredWalletRecord | null> {
    return this.found;
  }
}

describe("PrivateKeyAccessService", () => {
  test("issues a code for an owned wallet and logs it", async () => {
    const logs: string[] = [];
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: (message) => logs.push(message),
    });

    const result = await service.issueRequest(identity, wallet.publicAddress);

    expect(result).toEqual({
      kind: "issued",
      expiresAt: "2026-05-25T12:15:00.000Z",
    });
    expect(logs[0]).toContain("123456");
    expect(logs[0]).toContain(wallet.publicAddress);
    expect(logs[0]).not.toContain(wallet.privateKey);
  });

  test("reveals private key when the next message is the matching code", async () => {
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);
    const result = await service.consumeNextMessage(identity, "123456");
    const second = await service.consumeNextMessage(identity, "123456");

    expect(result).toEqual({
      kind: "revealed",
      publicAddress: wallet.publicAddress,
      privateKey: wallet.privateKey,
    });
    expect(second).toEqual({ kind: "none" });
  });

  test("cancels on wrong code", async () => {
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);

    expect(await service.consumeNextMessage(identity, "000000")).toEqual({
      kind: "canceled",
      reason: "wrong_code",
    });
    expect(await service.consumeNextMessage(identity, "123456")).toEqual({ kind: "none" });
  });

  test("cancels on unrelated next message", async () => {
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);

    expect(await service.consumeNextMessage(identity, "hello bot")).toEqual({
      kind: "canceled",
      reason: "unexpected_message",
    });
  });

  test("cancels expired pending request", async () => {
    let now = new Date("2026-05-25T12:00:00.000Z");
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => now,
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);
    now = new Date("2026-05-25T12:16:00.000Z");

    expect(await service.consumeNextMessage(identity, "123456")).toEqual({
      kind: "canceled",
      reason: "expired",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
bun test src/wallets/private-key-access-service.test.ts
```

Expected: FAIL because `PrivateKeyAccessService` does not exist.

- [ ] **Step 4: Implement private-key access service**

Create `src/wallets/private-key-access-service.ts`:

```ts
import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type {
  PrivateKeyConsumeResult,
  PrivateKeyRequestResult,
  StoredWalletRecord,
  TelegramIdentity,
} from "./types.ts";

interface WalletReader {
  findWalletForUser(telegramUserId: string, publicAddress: string): Promise<StoredWalletRecord | null>;
}

interface PendingPrivateKeyRequest {
  codeHash: string;
  publicAddress: string;
  expiresAt: string;
}

interface PrivateKeyAccessServiceOptions {
  walletStore: WalletReader;
  verificationLogFile?: string;
  logger?: Pick<Logger, "info" | "error">;
  now?: () => Date;
  ttlMs?: number;
  generateCode?: () => string;
  appendLog?: (message: string) => Promise<void> | void;
}

export class PrivateKeyAccessService {
  private readonly pending = new Map<string, PendingPrivateKeyRequest>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly generateCode: () => string;
  private readonly appendLog: (message: string) => Promise<void> | void;

  constructor(private readonly options: PrivateKeyAccessServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.generateCode = options.generateCode ?? defaultGenerateCode;
    this.appendLog = options.appendLog ?? ((message: string) => {
      if (!options.verificationLogFile) return undefined;
      const logsDir = path.dirname(options.verificationLogFile);
      const logFile = path.join(logsDir, `${todayDateStr()}-verification.log`);
      return appendFile(logFile, `${message}\n`, "utf8");
    });
  }

  async issueRequest(
    identity: TelegramIdentity,
    publicAddress: string,
  ): Promise<PrivateKeyRequestResult> {
    const wallet = await this.options.walletStore.findWalletForUser(
      identity.telegramUserId,
      publicAddress,
    );

    if (!wallet) {
      this.pending.delete(identity.telegramUserId);
      return { kind: "not_found" };
    }

    const code = this.generateCode();
    const issuedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();

    this.pending.set(identity.telegramUserId, {
      codeHash: hashCode(code),
      publicAddress,
      expiresAt,
    });

    const entry = JSON.stringify({
      type: "wallet_private_key_access",
      telegramUserId: identity.telegramUserId,
      username: identity.username,
      firstName: identity.firstName,
      publicAddress,
      code,
      issuedAt,
      expiresAt,
    });

    await this.appendLog(entry);
    this.options.logger?.info(
      `\n═══════════════════════════════════════════════════════════\n` +
      `  WALLET PRIVATE KEY CODE: ${code}\n` +
      `  User: @${identity.username ?? identity.telegramUserId}\n` +
      `  Public Address: ${publicAddress}\n` +
      `  Expires: ${expiresAt}\n` +
      `═══════════════════════════════════════════════════════════\n`,
    );

    return { kind: "issued", expiresAt };
  }

  async consumeNextMessage(
    identity: TelegramIdentity,
    input: string,
  ): Promise<PrivateKeyConsumeResult> {
    const pending = this.pending.get(identity.telegramUserId);
    if (!pending) return { kind: "none" };

    this.pending.delete(identity.telegramUserId);

    if (new Date(pending.expiresAt).getTime() <= this.now().getTime()) {
      return { kind: "canceled", reason: "expired" };
    }

    const trimmed = input.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      return { kind: "canceled", reason: "unexpected_message" };
    }

    if (hashCode(trimmed) !== pending.codeHash) {
      return { kind: "canceled", reason: "wrong_code" };
    }

    const wallet = await this.options.walletStore.findWalletForUser(
      identity.telegramUserId,
      pending.publicAddress,
    );

    if (!wallet) {
      return { kind: "canceled", reason: "not_found" };
    }

    return {
      kind: "revealed",
      publicAddress: wallet.publicAddress,
      privateKey: wallet.privateKey,
    };
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function defaultGenerateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function todayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
bun test src/wallets/private-key-access-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wallets/types.ts src/wallets/private-key-access-service.ts src/wallets/private-key-access-service.test.ts
git commit -m "feat: add wallet private key access codes"
```

---

### Task 6: Add wallet command handlers

**Files:**
- Create: `src/telegram/wallet-command-handlers.ts`
- Create: `src/telegram/wallet-command-handlers.test.ts`

- [ ] **Step 1: Write failing command handler tests**

Create `src/telegram/wallet-command-handlers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createWalletsGenHandler,
  createWalletsNowHandler,
  createWalletsPrivateKeyHandler,
} from "./wallet-command-handlers.ts";

function createCtx(match = "") {
  const replies: string[] = [];
  return {
    ctx: {
      from: {
        id: 42,
        username: "terry",
        first_name: "Terry",
      },
      match,
      reply: async (message: string) => {
        replies.push(message);
      },
    },
    replies,
  };
}

describe("wallet command handlers", () => {
  test("/wallets-gen replies with public address only", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsGenHandler({
      walletService: {
        createWallet: async () => ({
          publicAddress: "Address111111111111111111111111111111111",
          backupSaved: true,
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual([
      "Wallet created.\nPublic address: Address111111111111111111111111111111111",
    ]);
  });

  test("/wallets-gen warns when backup fails", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsGenHandler({
      walletService: {
        createWallet: async () => ({
          publicAddress: "Address111111111111111111111111111111111",
          backupSaved: false,
        }),
      },
    });

    await handler(ctx as never);

    expect(replies[0]).toBe(
      "Wallet created, but backup failed. Public address: Address111111111111111111111111111111111",
    );
  });

  test("/wallets-now lists public addresses", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsNowHandler({
      walletService: {
        listPublicAddresses: async () => ["Address111", "Address222"],
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Active wallets:\n1. Address111\n2. Address222"]);
  });

  test("/wallets-now handles empty list", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsNowHandler({
      walletService: {
        listPublicAddresses: async () => [],
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["No wallets found."]);
  });

  test("/wallets-privatekey requires address", async () => {
    const { ctx, replies } = createCtx("");
    const handler = createWalletsPrivateKeyHandler({
      privateKeyAccessService: {
        issueRequest: async () => ({ kind: "issued" as const, expiresAt: "unused" }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Usage: /wallets-privatekey <public-address>"]);
  });

  test("/wallets-privatekey starts code flow for owned wallet", async () => {
    const { ctx, replies } = createCtx("Address111");
    const handler = createWalletsPrivateKeyHandler({
      privateKeyAccessService: {
        issueRequest: async () => ({
          kind: "issued" as const,
          expiresAt: "2026-05-25T12:15:00.000Z",
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual([
      "Private key access code issued. Check server logs and send the 6-digit code as your next message within 15 minutes.",
    ]);
  });

  test("/wallets-privatekey hides unknown and unowned wallets", async () => {
    const { ctx, replies } = createCtx("Address111");
    const handler = createWalletsPrivateKeyHandler({
      privateKeyAccessService: {
        issueRequest: async () => ({ kind: "not_found" as const }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Wallet not found."]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/telegram/wallet-command-handlers.test.ts
```

Expected: FAIL because `wallet-command-handlers.ts` does not exist.

- [ ] **Step 3: Implement wallet command handlers**

Create `src/telegram/wallet-command-handlers.ts`:

```ts
import type { PrivateKeyAccessService } from "../wallets/private-key-access-service.ts";
import type { WalletService } from "../wallets/wallet-service.ts";

interface WalletCommandContextLike {
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  match?: string;
  reply(text: string): Promise<unknown>;
}

export function createWalletsGenHandler(deps: {
  walletService: Pick<WalletService, "createWallet">;
}) {
  return async function walletsGen(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const result = await deps.walletService.createWallet(String(ctx.from.id));
    if (!result.backupSaved) {
      await ctx.reply(`Wallet created, but backup failed. Public address: ${result.publicAddress}`);
      return;
    }

    await ctx.reply(`Wallet created.\nPublic address: ${result.publicAddress}`);
  };
}

export function createWalletsNowHandler(deps: {
  walletService: Pick<WalletService, "listPublicAddresses">;
}) {
  return async function walletsNow(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const publicAddresses = await deps.walletService.listPublicAddresses(String(ctx.from.id));
    if (publicAddresses.length === 0) {
      await ctx.reply("No wallets found.");
      return;
    }

    const list = publicAddresses
      .map((publicAddress, index) => `${index + 1}. ${publicAddress}`)
      .join("\n");
    await ctx.reply(`Active wallets:\n${list}`);
  };
}

export function createWalletsPrivateKeyHandler(deps: {
  privateKeyAccessService: Pick<PrivateKeyAccessService, "issueRequest">;
}) {
  return async function walletsPrivateKey(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const publicAddress = String(ctx.match ?? "").trim();
    if (!publicAddress) {
      await ctx.reply("Usage: /wallets-privatekey <public-address>");
      return;
    }

    const result = await deps.privateKeyAccessService.issueRequest({
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    }, publicAddress);

    if (result.kind === "not_found") {
      await ctx.reply("Wallet not found.");
      return;
    }

    await ctx.reply(
      "Private key access code issued. Check server logs and send the 6-digit code as your next message within 15 minutes.",
    );
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/telegram/wallet-command-handlers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/wallet-command-handlers.ts src/telegram/wallet-command-handlers.test.ts
git commit -m "feat: add wallet Telegram command handlers"
```

---

### Task 7: Intercept private-key code replies in text handler

**Files:**
- Modify: `src/telegram/handler.ts`
- Modify: `src/telegram/handler.test.ts`

- [ ] **Step 1: Add failing handler tests**

Append these tests inside `describe("createTextHandler", () => { ... })` in `src/telegram/handler.test.ts`:

```ts
  test("reveals private key from a pending wallet code before chat", async () => {
    const { ctx, replies } = createCtx("123456");
    let chatCalled = false;
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          chatCalled = true;
          return "unused";
        },
      },
      privateKeyAccessService: {
        consumeNextMessage: async () => ({
          kind: "revealed" as const,
          publicAddress: "Address111",
          privateKey: "PrivateKey111",
        }),
      },
    });

    await handler(ctx as never);

    expect(chatCalled).toBe(false);
    expect(replies).toEqual([
      "Private key for Address111:\nPrivateKey111",
    ]);
  });

  test("cancels pending wallet private key request before chat", async () => {
    const { ctx, replies } = createCtx("hello");
    let chatCalled = false;
    const handler = createTextHandler({
      verificationService: {
        isVerified: async () => true,
        handleUnverifiedInput: async () => ({ kind: "verified" as const }),
      },
      chatService: {
        replyToUser: async () => {
          chatCalled = true;
          return "unused";
        },
      },
      privateKeyAccessService: {
        consumeNextMessage: async () => ({
          kind: "canceled" as const,
          reason: "unexpected_message" as const,
        }),
      },
    });

    await handler(ctx as never);

    expect(chatCalled).toBe(false);
    expect(replies).toEqual([
      "Private key request canceled. Run /wallets-privatekey <public-address> to request a new code.",
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/telegram/handler.test.ts
```

Expected: FAIL because `createTextHandler` does not accept `privateKeyAccessService`.

- [ ] **Step 3: Modify text handler dependencies and intercept flow**

Update `src/telegram/handler.ts` to this exact content:

```ts
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";
import type { PrivateKeyAccessService } from "../wallets/private-key-access-service.ts";

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
  privateKeyAccessService?: Pick<PrivateKeyAccessService, "consumeNextMessage">;
  logger?: Pick<Logger, "error">;
}) {
  return async function handleTextMessage(ctx: TelegramTextContextLike): Promise<void> {
    try {
      if (!ctx.from || !ctx.message?.text) return;

      const identity = {
        telegramUserId: String(ctx.from.id),
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      };
      const text = ctx.message.text.trim();
      if (!text) return;

      const privateKeyResult = await deps.privateKeyAccessService?.consumeNextMessage(identity, text);
      if (privateKeyResult?.kind === "revealed") {
        await ctx.reply(`Private key for ${privateKeyResult.publicAddress}:\n${privateKeyResult.privateKey}`);
        return;
      }
      if (privateKeyResult?.kind === "canceled") {
        await ctx.reply("Private key request canceled. Run /wallets-privatekey <public-address> to request a new code.");
        return;
      }

      if (await deps.verificationService.isVerified(identity.telegramUserId)) {
        try {
          const reply = await deps.chatService.replyToUser({
            telegramUserId: ctx.from.id,
            text,
          });
          await ctx.reply(reply);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          deps.logger?.error(`[handler] Chat reply failed: ${msg}`);
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
        await ctx.reply("Invalid code. Check the server logs for the current code and try again.");
        return;
      }

      await ctx.reply(
        "Verification required. Check the server logs for your 6-digit code and send it here within 15 minutes.",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.logger?.error(`[handler] Unhandled error in text handler: ${msg}`);
      try {
        await ctx.reply("An internal error occurred. Please try again.");
      } catch { /* ignore reply errors */ }
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/telegram/handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/handler.ts src/telegram/handler.test.ts
git commit -m "feat: intercept wallet private key code replies"
```

---

### Task 8: Wire wallet commands into bot and main

**Files:**
- Modify: `src/telegram/bot.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Modify bot wiring**

Update `src/telegram/bot.ts` to this exact content:

```ts
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";
import type { PrivateKeyAccessService } from "../wallets/private-key-access-service.ts";
import type { WalletService } from "../wallets/wallet-service.ts";
import { createTextHandler } from "./handler.ts";
import {
  createWalletsGenHandler,
  createWalletsNowHandler,
  createWalletsPrivateKeyHandler,
} from "./wallet-command-handlers.ts";

export function createBot(deps: {
  token: string;
  logger: Logger;
  verificationService: VerificationService;
  chatService: ChatService;
  walletService: WalletService;
  privateKeyAccessService: PrivateKeyAccessService;
}) {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    deps.logger.info(`update=${ctx.update.update_id}`);
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome!\n\n" +
      "Commands:\n" +
      "/verify — Get a fresh verification code (check server logs for the code)\n" +
      "/wallets-gen — Generate one Solana wallet and save it\n" +
      "/wallets-now — Show your saved wallet public addresses\n" +
      "/wallets-privatekey <public-address> — Request a code to reveal a private key\n" +
      "\n" +
      "If you're not verified yet, send any message to begin the one-time verification process.",
    );
  });

  bot.command("verify", async (ctx) => {
    if (!ctx.from) return;

    const identity = {
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    };

    try {
      const result = await deps.verificationService.issueFreshCode(identity);

      if (result.kind === "verified") {
        await ctx.reply("You are already verified. You can chat now.");
        return;
      }

      await ctx.reply(
        "A fresh verification code has been issued. Check the server logs for your code and send it here.",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.logger.error(`[bot] /verify error: ${msg}`);
      await ctx.reply("Failed to issue verification code. Please try again.");
    }
  });

  bot.command("wallets-gen", createWalletsGenHandler({
    walletService: deps.walletService,
  }));

  bot.command("wallets-now", createWalletsNowHandler({
    walletService: deps.walletService,
  }));

  bot.command("wallets-privatekey", createWalletsPrivateKeyHandler({
    privateKeyAccessService: deps.privateKeyAccessService,
  }));

  bot.on(
    "message:text",
    createTextHandler({
      verificationService: deps.verificationService,
      chatService: deps.chatService,
      privateKeyAccessService: deps.privateKeyAccessService,
      logger: deps.logger,
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

- [ ] **Step 2: Modify main wiring**

Update the imports near the top of `src/main.ts` to include:

```ts
import { PrivateKeyAccessService } from "./wallets/private-key-access-service.ts";
import { WalletService } from "./wallets/wallet-service.ts";
import { WalletStore } from "./wallets/wallet-store.ts";
```

Then insert this block after the `verificationService` creation:

```ts
  const primaryWalletStore = new WalletStore(paths.walletsDbFile);
  const backupWalletStore = new WalletStore(paths.walletsBackupDbFile);
  const walletService = new WalletService({
    primaryStore: primaryWalletStore,
    backupStore: backupWalletStore,
    logger,
  });
  const privateKeyAccessService = new PrivateKeyAccessService({
    walletStore: primaryWalletStore,
    verificationLogFile: paths.verificationLogFile,
    logger,
  });
```

Then update the `createBot` call to pass wallet dependencies:

```ts
  const bot = createBot({
    token: env.botToken,
    logger,
    verificationService,
    chatService,
    walletService,
    privateKeyAccessService,
  });
```

Then update the shutdown function so wallet stores close before memory/logger cleanup:

```ts
  const shutdown = async () => {
    if (polling) {
      await bot.stop();
      await polling.catch(() => undefined);
    }
    if (offloadService) {
      await offloadService.close();
    }
    primaryWalletStore.close();
    backupWalletStore.close();
    await memory.close();
    await logger.close();
    process.exit(0);
  };
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun test src/telegram/wallet-command-handlers.test.ts src/telegram/handler.test.ts src/wallets/*.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
bun run build
```

Expected: build succeeds and writes `dist/index.js`.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/bot.ts src/main.ts
git commit -m "feat: wire wallet commands into Telegram bot"
```

---

### Task 9: Document wallet commands and storage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README command docs**

In `README.md`, after the verification flow section, insert:

```md
## Wallet commands

- `/wallets-gen` — Generate one Solana wallet, save it in SQLite, and reply with the public address only.
- `/wallets-now` — List your saved wallet public addresses.
- `/wallets-privatekey <public-address>` — Issue a 6-digit code in the server logs. Send that code as your next Telegram message to reveal the private key. Any other next message cancels the request.

Wallet secrets are not shown by `/wallets-gen` or `/wallets-now`.
```

In the memory storage list, add these bullets:

```md
- Wallet primary database: `data/wallets/wallets.sqlite`
- Wallet backup database: `data/wallets/wallets-backup.sqlite`
```

- [ ] **Step 2: Verify README contains the command names**

Run:

```bash
grep -n "wallets-gen\|wallets-now\|wallets-privatekey\|wallets-backup.sqlite" README.md
```

Expected: output includes all three command names and `wallets-backup.sqlite`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document wallet commands"
```

---

### Task 10: Final verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run wallet tests**

Run:

```bash
bun test src/wallets/*.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Telegram tests**

Run:

```bash
bun test src/telegram/handler.test.ts src/telegram/wallet-command-handlers.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full unit suite**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional files are modified, or nothing is modified if all task commits were made.

- [ ] **Step 6: Manual Telegram smoke test**

Run the bot locally with valid `.env` values:

```bash
bun run index.ts
```

In Telegram, test this sequence:

```text
/wallets-gen
/wallets-now
/wallets-privatekey <public-address-from-wallets-now>
<6-digit-code-from-server-log>
```

Expected:

- `/wallets-gen` returns only the public address.
- `/wallets-now` lists that public address.
- `/wallets-privatekey <public-address>` logs a code and asks for the next message.
- Sending the code reveals the private key.
- Sending any other message after requesting a private key cancels the request and does not reach AI chat.

- [ ] **Step 7: Final commit if verification changed files**

If any verification step changed tracked files, commit them:

```bash
git add <changed-files>
git commit -m "test: verify wallet command flow"
```

If no files changed, do not create an empty commit.

---

## Self-review

- Spec coverage: The plan covers wallet generation, primary+backup SQLite storage, `/wallets-gen`, `/wallets-now`, `/wallets-privatekey <public-address>`, one-time logged code, next-message cancel behavior, 15-minute expiration, and no mnemonic/private-key leaks in normal wallet commands.
- Placeholder scan: The plan contains concrete files, code blocks, commands, and expected results for each task.
- Type consistency: `GeneratedWallet`, `WalletRecord`, `StoredWalletRecord`, `WalletService`, `WalletStore`, `PrivateKeyAccessService`, and Telegram handler dependency names are consistent across tasks.
