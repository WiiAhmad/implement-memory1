import type { AppPaths } from "../utils/paths.ts";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.ts";
import type {
  PendingCodeMap,
  PendingVerificationRecord,
  VerifiedUserMap,
  VerifiedUserRecord,
} from "./types.ts";

export class JsonAuthStore {
  private static readonly fileQueues = new Map<string, Promise<void>>();

  constructor(private readonly paths: AppPaths) {}

  async getPending(telegramUserId: string): Promise<PendingVerificationRecord | null> {
    const pending = await readJsonFile<PendingCodeMap>(this.paths.pendingCodesFile, {});
    return pending[telegramUserId] ?? null;
  }

  async savePending(record: PendingVerificationRecord): Promise<void> {
    await this.withFileQueue(this.paths.pendingCodesFile, async () => {
      const pending = await readJsonFile<PendingCodeMap>(this.paths.pendingCodesFile, {});
      pending[record.telegramUserId] = record;
      await writeJsonFileAtomic(this.paths.pendingCodesFile, pending);
    });
  }

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

  async isVerified(telegramUserId: string): Promise<boolean> {
    const verified = await readJsonFile<VerifiedUserMap>(this.paths.verifiedUsersFile, {});
    return telegramUserId in verified;
  }

  async saveVerified(record: VerifiedUserRecord): Promise<void> {
    await this.withFileQueue(this.paths.verifiedUsersFile, async () => {
      const verified = await readJsonFile<VerifiedUserMap>(this.paths.verifiedUsersFile, {});
      verified[record.telegramUserId] = record;
      await writeJsonFileAtomic(this.paths.verifiedUsersFile, verified);
    });
  }

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
