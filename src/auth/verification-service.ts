import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { JsonAuthStore } from "./auth-store.ts";
import type {
  PendingVerificationRecord,
  TelegramIdentity,
  VerificationResult,
  VerifiedUserRecord,
} from "./types.ts";

interface VerificationServiceOptions {
  store: JsonAuthStore;
  verificationLogFile: string;
  logger?: Pick<Logger, "info">;
  now?: () => Date;
  ttlMs?: number;
  generateCode?: () => string;
  appendLog?: (message: string) => Promise<void> | void;
}

export class VerificationService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly generateCode: () => string;
  private readonly appendLog: (message: string) => Promise<void> | void;
  private readonly logger?: Pick<Logger, "info">;

  constructor(private readonly options: VerificationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.generateCode = options.generateCode ?? defaultGenerateCode;
    this.appendLog =
      options.appendLog ??
      ((message: string) => appendFile(options.verificationLogFile, `${message}\n`, "utf8"));
    this.logger = options.logger;
  }

  async isVerified(telegramUserId: string): Promise<boolean> {
    return this.options.store.isVerified(telegramUserId);
  }

  async handleUnverifiedInput(
    identity: TelegramIdentity,
    input: string,
  ): Promise<VerificationResult> {
    if (await this.options.store.isVerified(identity.telegramUserId)) {
      return { kind: "verified" };
    }

    const pending = await this.options.store.getPending(identity.telegramUserId);
    const now = this.now();

    if (!pending) {
      return this.issueCode(identity, now);
    }

    if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
      return this.issueCode(identity, now);
    }

    if (hashCode(input) !== pending.codeHash) {
      await this.options.store.incrementPendingAttempt(identity.telegramUserId);
      return {
        kind: "invalid_code",
        expiresAt: pending.expiresAt,
      };
    }

    const timestamp = now.toISOString();
    const verifiedRecord: VerifiedUserRecord = {
      ...identity,
      verifiedAt: timestamp,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    };

    const verificationEntry = JSON.stringify({
      telegramUserId: identity.telegramUserId,
      username: identity.username,
      firstName: identity.firstName,
      code: input,
      verifiedAt: timestamp,
    });
    await this.appendLog(verificationEntry);
    this.logger?.info(`verification ${verificationEntry}`);
    await this.options.store.saveVerified(verifiedRecord);
    await this.options.store.deletePending(identity.telegramUserId);

    return { kind: "verified" };
  }

  private async issueCode(
    identity: TelegramIdentity,
    now: Date,
  ): Promise<VerificationResult> {
    const code = this.generateCode();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const record: PendingVerificationRecord = {
      ...identity,
      codeHash: hashCode(code),
      issuedAt,
      expiresAt,
      attemptCount: 0,
    };

    const verificationEntry = JSON.stringify({
      telegramUserId: identity.telegramUserId,
      username: identity.username,
      firstName: identity.firstName,
      code,
      issuedAt,
      expiresAt,
    });
    await this.appendLog(verificationEntry);
    this.logger?.info(`verification ${verificationEntry}`);
    await this.options.store.savePending(record);

    return {
      kind: "awaiting_code",
      expiresAt,
    };
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function defaultGenerateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
