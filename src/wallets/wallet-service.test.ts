import { describe, expect, test } from "bun:test";
import { WalletService } from "./wallet-service.ts";
import type { GeneratedWallet, WalletRecord } from "./types.ts";

class FakeStore {
  records: WalletRecord[] = [];
  fail = false;

  async saveWallet(record: WalletRecord): Promise<void> {
    if (this.fail) throw new Error("save failed");
    this.records.push(record);
  }

  async countWallets(telegramUserId: string): Promise<number> {
    return this.records.filter((record) => record.telegramUserId === telegramUserId).length;
  }

  async listWallets(telegramUserId: string) {
    return this.records
      .filter((record) => record.telegramUserId === telegramUserId)
      .map((record) => ({
        publicAddress: record.publicAddress,
        isActive: record.isActive,
      }));
  }

  async getActivePublicAddress(telegramUserId: string): Promise<string | null> {
    return this.records.find((record) => (
      record.telegramUserId === telegramUserId && record.isActive
    ))?.publicAddress ?? null;
  }

  async setActiveWallet(telegramUserId: string, publicAddress: string): Promise<boolean> {
    if (this.fail) throw new Error("save failed");
    const wallet = this.records.find((record) => (
      record.telegramUserId === telegramUserId && record.publicAddress === publicAddress
    ));
    if (!wallet) return false;

    for (const record of this.records) {
      if (record.telegramUserId === telegramUserId) {
        record.isActive = record.publicAddress === publicAddress;
      }
    }
    return true;
  }

  async deleteWallet(telegramUserId: string, publicAddress: string): Promise<string | null | false> {
    if (this.fail) throw new Error("save failed");
    const index = this.records.findIndex((record) => (
      record.telegramUserId === telegramUserId && record.publicAddress === publicAddress
    ));
    if (index === -1) return false;

    const [deleted] = this.records.splice(index, 1);
    if (deleted?.isActive) {
      const replacement = this.records.findLast((record) => record.telegramUserId === telegramUserId);
      if (replacement) replacement.isActive = true;
      return replacement?.publicAddress ?? null;
    }
    return this.getActivePublicAddress(telegramUserId);
  }
}

const generated: GeneratedWallet = {
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "PrivateKey111111111111111111111111111111111",
  publicAddress: "Address111111111111111111111111111111111",
};

describe("WalletService", () => {
  test("saves generated wallet to primary and backup", async () => {
    const primary = new FakeStore();
    const backup = new FakeStore();
    const service = new WalletService({
      primaryStore: primary,
      backupStore: backup,
      generateWallet: () => generated,
      now: () => new Date("2026-05-25T12:00:00.000Z"),
    });

    const result = await service.createWallet("42");

    expect(result).toEqual({
      kind: "created",
      publicAddress: "Address111111111111111111111111111111111",
      backupSaved: true,
    });
    expect(primary.records).toHaveLength(1);
    expect(backup.records).toEqual(primary.records);
    expect(primary.records[0]).toMatchObject({
      telegramUserId: "42",
      createdAt: "2026-05-25T12:00:00.000Z",
      isActive: true,
    });
  });

  test("returns backupSaved false when backup write fails after primary succeeds", async () => {
    const primary = new FakeStore();
    const backup = new FakeStore();
    backup.fail = true;
    const logged: string[] = [];
    const service = new WalletService({
      primaryStore: primary,
      backupStore: backup,
      generateWallet: () => generated,
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      logger: { error: (message) => logged.push(message) },
    });

    const result = await service.createWallet("42");

    expect(result.backupSaved).toBe(false);
    expect(primary.records).toHaveLength(1);
    expect(logged[0]).toContain("Wallet backup save failed");
  });

  test("rejects generation after ten wallets", async () => {
    const primary = new FakeStore();
    const backup = new FakeStore();
    for (let index = 0; index < 10; index += 1) {
      primary.records.push({
        ...generated,
        telegramUserId: "42",
        publicAddress: `Address${index}`,
        createdAt: "2026-05-25T12:00:00.000Z",
        isActive: index === 0,
      });
    }
    const service = new WalletService({
      primaryStore: primary,
      backupStore: backup,
      generateWallet: () => generated,
      maxWallets: 10,
    });

    await expect(service.createWallet("42")).resolves.toEqual({
      kind: "limit_reached",
      limit: 10,
    });
    expect(backup.records).toHaveLength(0);
  });

  test("changes and deletes active wallets with backup writes", async () => {
    const primary = new FakeStore();
    const backup = new FakeStore();
    const first: WalletRecord = {
      ...generated,
      telegramUserId: "42",
      publicAddress: "Address111",
      createdAt: "2026-05-25T12:00:00.000Z",
      isActive: true,
    };
    const second: WalletRecord = {
      ...generated,
      telegramUserId: "42",
      publicAddress: "Address222",
      createdAt: "2026-05-25T12:01:00.000Z",
      isActive: false,
    };
    primary.records.push({ ...first }, { ...second });
    backup.records.push({ ...first }, { ...second });
    const service = new WalletService({
      primaryStore: primary,
      backupStore: backup,
      generateWallet: () => generated,
    });

    await expect(service.setActiveWallet("42", "Address222")).resolves.toEqual({
      kind: "activated",
      publicAddress: "Address222",
      backupSaved: true,
    });
    await expect(service.deleteWallet("42", "Address222")).resolves.toEqual({
      kind: "deleted",
      publicAddress: "Address222",
      newActivePublicAddress: "Address111",
      backupSaved: true,
    });
  });
});
