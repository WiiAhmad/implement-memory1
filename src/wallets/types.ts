export interface GeneratedWallet {
  mnemonic: string;
  privateKey: string;
  publicAddress: string;
}

export interface WalletRecord extends GeneratedWallet {
  telegramUserId: string;
  createdAt: string;
  isActive: boolean;
}

export interface StoredWalletRecord extends WalletRecord {
  id: number;
}

export interface WalletCreationResult {
  kind: "created";
  publicAddress: string;
  backupSaved: boolean;
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
