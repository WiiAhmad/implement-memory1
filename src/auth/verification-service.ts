import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
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
      ((message: string) => {
        const today = todayDateStr();
        const logsDir = path.dirname(options.verificationLogFile);
        const logFile = path.join(logsDir, `${today}-verification.log`);
        return appendFile(logFile, `${message}\n`, "utf8");
      });
    this.logger = options.logger;
  }

  async isVerified(telegramUserId: string): Promise<boolean> {
    return this.options.store.isVerified(telegramUserId);
  }

  /**
   * Force-issue a fresh verification code, deleting any existing pending one.
   * Returns `verified` if the user is already verified.
   */
  async issueFreshCode(identity: TelegramIdentity): Promise<VerificationResult> {
    if (await this.options.store.isVerified(identity.telegramUserId)) {
      return { kind: "verified" };
    }

    // No need to delete the old pending code — savePending overwrites by telegramUserId
    return this.issueCode(identity, this.now());
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
    this.logger?.info(
      `\n═══════════════════════════════════════════════════════════\n` +
      `  🔐 VERIFICATION CODE: ${code}\n` +
      `  User: @${identity.username ?? identity.telegramUserId}\n` +
      `  Expires: ${expiresAt}\n` +
      `  Entry: ${verificationEntry}\n` +
      `═══════════════════════════════════════════════════════════\n`,
    );
    await this.options.store.savePending(record);

    return {
      kind: "awaiting_code",
      expiresAt,
      code,
    };
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** ISO date string in yyyy-mm-dd format. */
function todayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function defaultGenerateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
