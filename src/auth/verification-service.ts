import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

  constructor(private readonly options: VerificationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.generateCode = options.generateCode ?? defaultGenerateCode;
    this.appendLog =
      options.appendLog ??
      ((message: string) => appendFile(options.verificationLogFile, `${message}\n`, "utf8"));
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

    await this.options.store.saveVerified(verifiedRecord);
    await this.options.store.deletePending(identity.telegramUserId);
    await this.appendLog(
      JSON.stringify({
        telegramUserId: identity.telegramUserId,
        username: identity.username,
        firstName: identity.firstName,
        code: input,
        verifiedAt: timestamp,
      }),
    );

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

    await this.options.store.savePending(record);
    await this.appendLog(
      JSON.stringify({
        telegramUserId: identity.telegramUserId,
        username: identity.username,
        firstName: identity.firstName,
        code,
        issuedAt,
        expiresAt,
      }),
    );

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
