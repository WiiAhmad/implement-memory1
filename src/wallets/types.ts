// ═══════════════════════════════════════════════════════════════════════
//  [Step 12]  WALLET TYPES — Type Definitions for Wallet Operations
//  ═══════════════════════════════════════════════════════════════════════
//  Defines all types used across the wallet ecosystem: generation, storage,
//  activation, deletion, and private key access.
// ═══════════════════════════════════════════════════════════════════════

// ─── Step 12a: Raw generated wallet (Solana) ──────────────────────────
export interface GeneratedWallet {
  mnemonic: string;       // BIP39 mnemonic phrase
  privateKey: string;     // Base58-encoded private key
  publicAddress: string;  // Solana public address (Base58)
}

// ─── Step 12b: Wallet record stored in SQLite ─────────────────────────
export interface WalletRecord extends GeneratedWallet {
  telegramUserId: string;  // Owner's Telegram user ID
  createdAt: string;       // ISO timestamp of creation
  isActive: boolean;       // Whether this is the user's active wallet
}

// ─── Step 12c: Wallet record WITH database ID (for internal queries) ──
export interface StoredWalletRecord extends WalletRecord {
  id: number;
}

// ─── Step 12d: Result types for wallet operations ─────────────────────
export interface WalletCreationResult {
  kind: "created";
  publicAddress: string;
  backupSaved: boolean;  // Whether backup DB write succeeded
}

export interface WalletPublicRecord {
  publicAddress: string;
  isActive: boolean;
}

export type WalletActivationResult =
  | { kind: "activated"; publicAddress: string; backupSaved: boolean }
  | { kind: "not_found" };

export type WalletDeletionResult =
  | { kind: "deleted"; publicAddress: string; newActivePublicAddress: string | null; backupSaved: boolean }
  | { kind: "not_found" };

export type WalletGenerationLimitResult = { kind: "limit_reached"; limit: number };

// ─── Step 12e: Private key access types ───────────────────────────────
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
  | {
      kind: "canceled";
      reason: "wrong_code" | "expired" | "not_found" | "unexpected_message";
    };
