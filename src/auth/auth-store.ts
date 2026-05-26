// ═══════════════════════════════════════════════════════════════════════
//  [Step 10]  AUTH STORE — JSON-Backed Persistence for Verification
//  ═══════════════════════════════════════════════════════════════════════
//  Reads/writes pending codes and verified users to JSON files.
//  Uses atomic writes (writeJsonFileAtomic) and per-file serial queues
//  to prevent race conditions from concurrent Telegram message handling.
// ═══════════════════════════════════════════════════════════════════════

import type { AppPaths } from "../utils/paths.ts";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.ts";
import type {
  PendingCodeMap,
  PendingVerificationRecord,
  VerifiedUserMap,
  VerifiedUserRecord,
} from "./types.ts";

export class JsonAuthStore {
  // ─── Step 10a: Per-file serial queue to prevent concurrent writes ─────
  //  Since Telegram can receive multiple messages at once, we serialize
  //  operations per file to prevent race conditions (read-modify-write cycles).
  private static readonly fileQueues = new Map<string, Promise<void>>();

  constructor(private readonly paths: AppPaths) {}

  // ─── Step 10b: Read pending record for a user ─────────────────────────
  async getPending(telegramUserId: string): Promise<PendingVerificationRecord | null> {
    const pending = await readJsonFile<PendingCodeMap>(this.paths.pendingCodesFile, {});
    return pending[telegramUserId] ?? null;
  }

  // ─── Step 10c: Save/overwrite pending record ──────────────────────────
  async savePending(record: PendingVerificationRecord): Promise<void> {
    await this.withFileQueue(this.paths.pendingCodesFile, async () => {
      const pending = await readJsonFile<PendingCodeMap>(this.paths.pendingCodesFile, {});
      pending[record.telegramUserId] = record;
      await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
    });
  }

  // ─── Step 10d: Delete a pending record ────────────────────────────────
  async deletePending(telegramUserId: string): Promise<void> {
    await this.withFileQueue(this.paths.pendingCodesFile, async () => {
      const pending = await readJsonFile<PendingCodeMap>(this.paths.pendingCodesFile, {});
      if (!(telegramUserId in pending)) {
        return;
      }

      delete pending[telegramUserId];
      await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
    });
  }

  // ─── Step 10e: Increment the attempt counter for a pending user ───────
  async incrementPendingAttempt(telegramUserId: string): Promise<void> {
    await this.withFileQueue(this.paths.pendingCodesFile, async () => {
      const pending = await readJsonFile<PendingCodeMap>(this.paths.pendingCodesFile, {});
      const record = pending[telegramUserId];

      if (!record) {
        return;
      }

      pending[telegramUserId] = {
        ...record,
        attemptCount: record.attemptCount + 1,
      };
      await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
    });
  }

  // ─── Step 10f: Check if a user is verified ────────────────────────────
  async isVerified(telegramUserId: string): Promise<boolean> {
    const verified = await readJsonFile<VerifiedUserMap>(this.paths.verifiedUsersFile, {});
    return telegramUserId in verified;
  }

  // ─── Step 10g: Save a verified user record ────────────────────────────
  async saveVerified(record: VerifiedUserRecord): Promise<void> {
    await this.withFileQueue(this.paths.verifiedUsersFile, async () => {
      const verified = await readJsonFile<VerifiedUserMap>(this.paths.verifiedUsersFile, {});
      verified[record.telegramUserId] = record;
      await writeJsonFileAtomic(this.paths.verifiedUsersFile, verified);
    });
  }

  // ─── Step 10h: Serial queue executor ─────────────────────────────────
  //  Chains operations on the same file so they run sequentially.
  //  Uses a Map of Promises: each new operation waits for the previous one.
  private async withFileQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = JsonAuthStore.fileQueues.get(filePath) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);

    JsonAuthStore.fileQueues.set(filePath, next);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseCurrent();
      await next;
      if (JsonAuthStore.fileQueues.get(filePath) === next) {
        JsonAuthStore.fileQueues.delete(filePath);
      }
    }
  }
}
