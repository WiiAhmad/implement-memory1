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
  findWalletForUser(
    telegramUserId: string,
    publicAddress: string,
  ): Promise<StoredWalletRecord | null>;
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
    const now = this.now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

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
      `\nWALLET PRIVATE KEY CODE: ${code}\n` +
      `User: @${identity.username ?? identity.telegramUserId}\n` +
      `Public Address: ${publicAddress}\n` +
      `Expires: ${expiresAt}\n`,
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
