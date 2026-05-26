// ═══════════════════════════════════════════════════════════════════════
//  [Step 9]  AUTH TYPES — Verification & Identity Type Definitions
//  ═══════════════════════════════════════════════════════════════════════
//  Type definitions for the Telegram user verification flow.
//  Used by JsonAuthStore and VerificationService.
// ═══════════════════════════════════════════════════════════════════════

// ─── Step 9a: Core identity types ──────────────────────────────────────
export interface TelegramIdentity {
  telegramUserId: string;     // Telegram user ID (as string)
  username: string | null;    // @username (nullable — some users have none)
  firstName: string | null;   // Display name (nullable)
}

// ─── Step 9b: Pending (unverified) user state ──────────────────────────
export interface PendingVerificationRecord extends TelegramIdentity {
  codeHash: string;           // SHA-256 hash of the 6-digit verification code
  issuedAt: string;           // ISO timestamp when the code was issued
  expiresAt: string;          // ISO timestamp when the code expires (15 min TTL)
  attemptCount: number;       // Number of incorrect attempts so far
}

// ─── Step 9c: Verified user record ─────────────────────────────────────
export interface VerifiedUserRecord extends TelegramIdentity {
  verifiedAt: string;         // When the user first verified
  firstSeenAt: string;        // When the user first messaged the bot
  lastSeenAt: string;         // When the user last messaged the bot
}

export type PendingCodeMap = Record<string, PendingVerificationRecord>;
export type VerifiedUserMap = Record<string, VerifiedUserRecord>;

// ─── Step 9d: Verification flow result types ───────────────────────────
export type VerificationResult =
  | { kind: "awaiting_code"; expiresAt: string; code: string }  // Code issued, waiting for user to send it
  | { kind: "invalid_code"; expiresAt: string }                  // Wrong code entered
  | { kind: "verified" };                                        // User is verified
