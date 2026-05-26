// ═══════════════════════════════════════════════════════════════════════
//  [Step 13]  WALLET STORE — SQLite-backed Wallet Persistence
//  ═══════════════════════════════════════════════════════════════════════
//  Manages wallet data in SQLite via bun:sqlite. Handles CRUD operations
//  for wallets with: creation, listing, activation, deletion.
//  Uses WAL mode for concurrent read performance.
// ═══════════════════════════════════════════════════════════════════════

import { Database } from "bun:sqlite";
import type { StoredWalletRecord, WalletPublicRecord, WalletRecord } from "./types.ts";

interface WalletRow {
  id: number;
  telegram_user_id: string;
  public_address: string;
  mnemonic: string;
  private_key: string;
  created_at: string;
  is_active: number;
}

export class WalletStore {
  private readonly db: Database;

  constructor(dbFile: string) {
    // ─── Step 13a: Open SQLite DB with schema initialization ───────────
    //  Creates the wallets table if it doesn't exist.
    //  Adds index on telegram_user_id for efficient per-user queries.
    //  Adds partial unique index for "one active wallet per user".
    //  Auto-assigns active wallet to newest wallet if none set.
    this.db = new Database(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT NOT NULL,
        public_address TEXT NOT NULL UNIQUE,
        mnemonic TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_wallets_telegram_user_id
      ON wallets (telegram_user_id);
    `);

    // Migration: add is_active column if missing (backward compat)
    const columns = this.db.query("PRAGMA table_info(wallets)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "is_active")) {
      this.db.exec("ALTER TABLE wallets ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0");
    }

    // Partial unique index: only one active wallet per user
    // Auto-activate the newest wallet if user has no active one
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_one_active_per_user
      ON wallets (telegram_user_id)
      WHERE is_active = 1;

      UPDATE wallets
      SET is_active = 1
      WHERE id IN (
        SELECT MAX(id)
        FROM wallets
        GROUP BY telegram_user_id
        HAVING SUM(is_active) = 0
      );
    `);
  }

  // ─── Step 13b: Save a new wallet ─────────────────────────────────────
  //  If the record is marked as active, deactivate all other wallets
  //  for the same user first (ensures one-active constraint).
  async saveWallet(record: WalletRecord): Promise<void> {
    if (record.isActive) {
      this.db.query(`
        UPDATE wallets
        SET is_active = 0
        WHERE telegram_user_id = ?
      `).run(record.telegramUserId);
    }

    this.db.query(`
      INSERT INTO wallets (
        telegram_user_id,
        public_address,
        mnemonic,
        private_key,
        created_at,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.telegramUserId,
      record.publicAddress,
      record.mnemonic,
      record.privateKey,
      record.createdAt,
      record.isActive ? 1 : 0,
    );
  }

  // ─── Step 13c: Count wallets for a user (for limit enforcement) ──────
  async countWallets(telegramUserId: string): Promise<number> {
    const row = this.db.query(`
      SELECT COUNT(*) AS count
      FROM wallets
      WHERE telegram_user_id = ?
    `).get(telegramUserId) as { count: number };

    return row.count;
  }

  // ─── Step 13d: List all wallet public addresses for a user ───────────
  async listWallets(telegramUserId: string): Promise<WalletPublicRecord[]> {
    const rows = this.db.query(`
      SELECT public_address, is_active
      FROM wallets
      WHERE telegram_user_id = ?
      ORDER BY id ASC
    `).all(telegramUserId) as Array<{ public_address: string; is_active: number }>;

    return rows.map((row) => ({
      publicAddress: row.public_address,
      isActive: row.is_active === 1,
    }));
  }

  // ─── Step 13e: List just the public addresses (no active status) ─────
  async listPublicAddresses(telegramUserId: string): Promise<string[]> {
    const rows = await this.listWallets(telegramUserId);
    return rows.map((row) => row.publicAddress);
  }

  // ─── Step 13f: Get the currently active wallet's public address ──────
  async getActivePublicAddress(telegramUserId: string): Promise<string | null> {
    const row = this.db.query(`
      SELECT public_address
      FROM wallets
      WHERE telegram_user_id = ? AND is_active = 1
      ORDER BY id DESC
      LIMIT 1
    `).get(telegramUserId) as { public_address: string } | null;

    return row?.public_address ?? null;
  }

  // ─── Step 13g: Set a specific wallet as active ───────────────────────
  //  Runs in a transaction: deactivates all wallets, then activates the target.
  async setActiveWallet(telegramUserId: string, publicAddress: string): Promise<boolean> {
    const wallet = await this.findWalletForUser(telegramUserId, publicAddress);
    if (!wallet) return false;

    this.db.exec("BEGIN");
    try {
      this.db.query(`
        UPDATE wallets
        SET is_active = 0
        WHERE telegram_user_id = ?
      `).run(telegramUserId);
      this.db.query(`
        UPDATE wallets
        SET is_active = 1
        WHERE telegram_user_id = ? AND public_address = ?
      `).run(telegramUserId, publicAddress);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ─── Step 13h: Delete a wallet ───────────────────────────────────────
  //  Runs in a transaction. If the deleted wallet was active, promotes
  //  the next most recent wallet to active.
  async deleteWallet(telegramUserId: string, publicAddress: string): Promise<string | null | false> {
    const wallet = await this.findWalletForUser(telegramUserId, publicAddress);
    if (!wallet) return false;

    this.db.exec("BEGIN");
    try {
      this.db.query(`
        DELETE FROM wallets
        WHERE telegram_user_id = ? AND public_address = ?
      `).run(telegramUserId, publicAddress);

      let newActivePublicAddress: string | null = null;
      if (wallet.isActive) {
        // Deleted wallet was active — promote the most recent remaining wallet
        const replacement = this.db.query(`
          SELECT public_address
          FROM wallets
          WHERE telegram_user_id = ?
          ORDER BY id DESC
          LIMIT 1
        `).get(telegramUserId) as { public_address: string } | null;

        if (replacement) {
          newActivePublicAddress = replacement.public_address;
          this.db.query(`
            UPDATE wallets
            SET is_active = 1
            WHERE telegram_user_id = ? AND public_address = ?
          `).run(telegramUserId, newActivePublicAddress);
        }
      } else {
        newActivePublicAddress = await this.getActivePublicAddress(telegramUserId);
      }

      this.db.exec("COMMIT");
      return newActivePublicAddress;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ─── Step 13i: Look up a specific wallet by user + public address ────
  async findWalletForUser(
    telegramUserId: string,
    publicAddress: string,
  ): Promise<StoredWalletRecord | null> {
    const row = this.db.query(`
      SELECT id, telegram_user_id, public_address, mnemonic, private_key, created_at, is_active
      FROM wallets
      WHERE telegram_user_id = ? AND public_address = ?
      LIMIT 1
    `).get(telegramUserId, publicAddress) as WalletRow | null;

    if (!row) return null;

    return {
      id: row.id,
      telegramUserId: row.telegram_user_id,
      publicAddress: row.public_address,
      mnemonic: row.mnemonic,
      privateKey: row.private_key,
      createdAt: row.created_at,
      isActive: row.is_active === 1,
    };
  }

  // ─── Step 13j: Close the database connection ────────────────────────
  close(): void {
    this.db.close();
  }
}
