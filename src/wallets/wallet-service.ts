// ═══════════════════════════════════════════════════════════════════════
//  [Step 14]  WALLET SERVICE — Business Logic for Wallet Operations
//  ═══════════════════════════════════════════════════════════════════════
//  Orchestrates wallet CRUD operations across primary + backup stores.
//  Handles: creation (with limit check), listing, activation, deletion.
//  Backup failures are logged but never block the primary operation.
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { generateSolanaWallet } from "./wallet-generator.ts";
import type {
  GeneratedWallet,
  WalletActivationResult,
  WalletCreationResult,
  WalletDeletionResult,
  WalletGenerationLimitResult,
  WalletPublicRecord,
  WalletRecord,
} from "./types.ts";

interface WalletWritableStore {
  saveWallet(record: WalletRecord): Promise<void>;
  countWallets(telegramUserId: string): Promise<number>;
  listWallets(telegramUserId: string): Promise<WalletPublicRecord[]>;
  getActivePublicAddress(telegramUserId: string): Promise<string | null>;
  setActiveWallet(telegramUserId: string, publicAddress: string): Promise<boolean>;
  deleteWallet(telegramUserId: string, publicAddress: string): Promise<string | null | false>;
}

interface WalletServiceOptions {
  primaryStore: WalletWritableStore;
  backupStore: Pick<WalletWritableStore, "saveWallet" | "setActiveWallet" | "deleteWallet">;
  generateWallet?: () => GeneratedWallet;
  now?: () => Date;
  maxWallets?: number;
  logger?: Pick<Logger, "error">;
}

export class WalletService {
  private readonly generateWallet: () => GeneratedWallet;
  private readonly now: () => Date;
  private readonly maxWallets: number;  // Default: 10 wallets per user

  constructor(private readonly options: WalletServiceOptions) {
    // ─── Step 14a: Apply defaults ───────────────────────────────────────
    this.generateWallet = options.generateWallet ?? generateSolanaWallet;
    this.now = options.now ?? (() => new Date());
    this.maxWallets = options.maxWallets ?? 10;
  }

  // ─── Step 14b: Create a new wallet for a user ────────────────────────
  //  1. Check if user has reached the wallet limit (10)
  //  2. Generate new Solana wallet (keypair from mnemonic)
  //  3. Save to primary store
  //  4. Attempt backup save (non-fatal if it fails)
  async createWallet(
    telegramUserId: string,
  ): Promise<WalletCreationResult | WalletGenerationLimitResult> {
    const existingCount = await this.options.primaryStore.countWallets(telegramUserId);
    if (existingCount >= this.maxWallets) {
      return { kind: "limit_reached", limit: this.maxWallets };
    }

    const wallet = this.generateWallet();
    const record: WalletRecord = {
      ...wallet,
      telegramUserId,
      createdAt: this.now().toISOString(),
      isActive: existingCount === 0,  // First wallet = auto-activate
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
      kind: "created",
      publicAddress: record.publicAddress,
      backupSaved,
    };
  }

  // ─── Step 14c: List all wallets for a user ───────────────────────────
  async listWallets(telegramUserId: string): Promise<WalletPublicRecord[]> {
    return this.options.primaryStore.listWallets(telegramUserId);
  }

  // ─── Step 14d: Get the active wallet address ─────────────────────────
  async getActivePublicAddress(telegramUserId: string): Promise<string | null> {
    return this.options.primaryStore.getActivePublicAddress(telegramUserId);
  }

  // ─── Step 14e: Set a wallet as active ────────────────────────────────
  //  Validates wallet exists, then updates active status in both stores.
  async setActiveWallet(
    telegramUserId: string,
    publicAddress: string,
  ): Promise<WalletActivationResult> {
    const activated = await this.options.primaryStore.setActiveWallet(telegramUserId, publicAddress);
    if (!activated) return { kind: "not_found" };

    let backupSaved = true;
    try {
      await this.options.backupStore.setActiveWallet(telegramUserId, publicAddress);
    } catch (error) {
      backupSaved = false;
      const msg = error instanceof Error ? error.message : String(error);
      this.options.logger?.error(`[wallets] Wallet backup active update failed: ${msg}`);
    }

    return { kind: "activated", publicAddress, backupSaved };
  }

  // ─── Step 14f: Delete a wallet ───────────────────────────────────────
  //  Deletes from both stores. Returns new active wallet if deleted was active.
  async deleteWallet(
    telegramUserId: string,
    publicAddress: string,
  ): Promise<WalletDeletionResult> {
    const newActivePublicAddress = await this.options.primaryStore.deleteWallet(
      telegramUserId,
      publicAddress,
    );
    if (newActivePublicAddress === false) return { kind: "not_found" };

    let backupSaved = true;
    try {
      await this.options.backupStore.deleteWallet(telegramUserId, publicAddress);
    } catch (error) {
      backupSaved = false;
      const msg = error instanceof Error ? error.message : String(error);
      this.options.logger?.error(`[wallets] Wallet backup delete failed: ${msg}`);
    }

    return {
      kind: "deleted",
      publicAddress,
      newActivePublicAddress,
      backupSaved,
    };
  }
}
