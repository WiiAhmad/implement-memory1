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
  private readonly maxWallets: number;

  constructor(private readonly options: WalletServiceOptions) {
    this.generateWallet = options.generateWallet ?? generateSolanaWallet;
    this.now = options.now ?? (() => new Date());
    this.maxWallets = options.maxWallets ?? 10;
  }

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
      isActive: existingCount === 0,
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

  async listWallets(telegramUserId: string): Promise<WalletPublicRecord[]> {
    return this.options.primaryStore.listWallets(telegramUserId);
  }

  async getActivePublicAddress(telegramUserId: string): Promise<string | null> {
    return this.options.primaryStore.getActivePublicAddress(telegramUserId);
  }

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
