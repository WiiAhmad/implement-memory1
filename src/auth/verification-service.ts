// ═══════════════════════════════════════════════════════════════════════
//  [Step 11]  VERIFICATION SERVICE — 6-Digit Code Auth Flow
//  ═══════════════════════════════════════════════════════════════════════
//  Handles the one-time verification process for Telegram users.
//  Flow: User messages bot → code issued (logged to server) → user sends
//  code → code verified → user can chat.
//  The code is NEVER sent back to the user via Telegram — only logged server-side.
// ═══════════════════════════════════════════════════════════════════════

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
  private readonly ttlMs: number;          // Code TTL (default: 15 min)
  private readonly generateCode: () => string;  // 6-digit code generator
  private readonly appendLog: (message: string) => Promise<void> | void;  // Audit log writer
  private readonly logger?: Pick<Logger, "info">;

  constructor(private readonly options: VerificationServiceOptions) {
    // ─── Step 11a: Apply defaults for all injectable dependencies ──────
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

  // ─── Step 11b: Check if user is already verified ─────────────────────
  async isVerified(telegramUserId: string): Promise<boolean> {
    return this.options.store.isVerified(telegramUserId);
  }

  // ─── Step 11c: Force-issue a fresh verification code ─────────────────
  //  Called by /verify command. Deletes any existing pending code and
  //  issues a new one. Returns "verified" if already verified.
  async issueFreshCode(identity: TelegramIdentity): Promise<VerificationResult> {
    if (await this.options.store.isVerified(identity.telegramUserId)) {
      return { kind: "verified" };
    }

    // No need to delete the old pending code — savePending overwrites by telegramUserId
    return this.issueCode(identity, this.now());
  }

  // ─── Step 11d: Handle any text from an unverified user ───────────────
  //  Called by the text message handler for unverified users.
  //  Flow:
  //    1. If verified → return verified
  //    2. If no pending code → issue one
  //    3. If pending code expired → issue new one
  //    4. If wrong code → increment attempts, return invalid_code
  //    5. If correct code → save as verified, return verified
  async handleUnverifiedInput(
    identity: TelegramIdentity,
    input: string,
  ): Promise<VerificationResult> {
    if (await this.options.store.isVerified(identity.telegramUserId)) {
      return { kind: "verified" };
    }

    const pending = await this.options.store.getPending(identity.telegramUserId);
    const now = this.now();

    // No pending code → issue one
    if (!pending) {
      return this.issueCode(identity, now);
    }

    // Code expired → issue new one
    if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
      return this.issueCode(identity, now);
    }

    // Wrong SHA-256 hash → increment attempts, reject
    if (hashCode(input) !== pending.codeHash) {
      await this.options.store.incrementPendingAttempt(identity.telegramUserId);
      return {
        kind: "invalid_code",
        expiresAt: pending.expiresAt,
      };
    }

    // ─── Correct code! Save verified user and clean up ──────────────
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

  // ─── Step 11e: Issue a verification code ────────────────────────────
  //  Generates 6-digit code, SHA-256 hashes it, saves the pending record,
  //  logs the code server-side (NOT sent to user via Telegram).
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

    // Log the code server-side (operator must read logs to tell user)
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

// ─── Step 11f: Utility functions ───────────────────────────────────────
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

/** Generate a random 6-digit code as a string. */
function defaultGenerateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
