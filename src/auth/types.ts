export interface TelegramIdentity {
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
}

export interface PendingVerificationRecord extends TelegramIdentity {
  codeHash: string;
  issuedAt: string;
  expiresAt: string;
  attemptCount: number;
}

export interface VerifiedUserRecord extends TelegramIdentity {
  verifiedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type PendingCodeMap = Record<string, PendingVerificationRecord>;
export type VerifiedUserMap = Record<string, VerifiedUserRecord>;

export type VerificationResult =
  | { kind: "awaiting_code"; expiresAt: string }
  | { kind: "invalid_code"; expiresAt: string }
  | { kind: "verified" };
