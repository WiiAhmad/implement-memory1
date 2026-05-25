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

    const columns = this.db.query("PRAGMA table_info(wallets)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "is_active")) {
      this.db.exec("ALTER TABLE wallets ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0");
    }

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

  async countWallets(telegramUserId: string): Promise<number> {
    const row = this.db.query(`
      SELECT COUNT(*) AS count
      FROM wallets
      WHERE telegram_user_id = ?
    `).get(telegramUserId) as { count: number };

    return row.count;
  }

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

  async listPublicAddresses(telegramUserId: string): Promise<string[]> {
    const rows = await this.listWallets(telegramUserId);
    return rows.map((row) => row.publicAddress);
  }

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

  close(): void {
    this.db.close();
  }
}
