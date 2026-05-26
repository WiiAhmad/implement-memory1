import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WalletStore } from "./wallet-store.ts";
import type { WalletRecord } from "./types.ts";

function wallet(overrides: Partial<WalletRecord> = {}): WalletRecord {
  return {
    telegramUserId: "42",
    publicAddress: "Address111111111111111111111111111111111",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    privateKey: "PrivateKey111111111111111111111111111111111",
    createdAt: "2026-05-25T12:00:00.000Z",
    isActive: true,
    ...overrides,
  };
}

describe("WalletStore", () => {
  test("saves and lists public addresses for one Telegram user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wallet-store-"));
    const store = new WalletStore(path.join(root, "wallets.sqlite"));

    try {
      await store.saveWallet(wallet());
      await store.saveWallet(wallet({
        telegramUserId: "99",
        publicAddress: "Address222222222222222222222222222222222",
      }));

      await expect(store.listPublicAddresses("42")).resolves.toEqual([
        "Address111111111111111111111111111111111",
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds a wallet only for its owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wallet-store-"));
    const store = new WalletStore(path.join(root, "wallets.sqlite"));

    try {
      await store.saveWallet(wallet());

      const owned = await store.findWalletForUser(
        "42",
        "Address111111111111111111111111111111111",
      );
      const otherUser = await store.findWalletForUser(
        "99",
        "Address111111111111111111111111111111111",
      );

      expect(owned?.privateKey).toBe("PrivateKey111111111111111111111111111111111");
      expect(otherUser).toBeNull();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tracks one active wallet per Telegram user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wallet-store-"));
    const store = new WalletStore(path.join(root, "wallets.sqlite"));

    try {
      await store.saveWallet(wallet());
      await store.saveWallet(wallet({
        publicAddress: "Address222222222222222222222222222222222",
        isActive: false,
      }));

      expect(await store.getActivePublicAddress("42")).toBe(
        "Address111111111111111111111111111111111",
      );
      expect(await store.setActiveWallet("42", "Address222222222222222222222222222222222")).toBe(true);
      expect(await store.getActivePublicAddress("42")).toBe(
        "Address222222222222222222222222222222222",
      );
      expect(await store.listWallets("42")).toEqual([
        {
          publicAddress: "Address111111111111111111111111111111111",
          isActive: false,
        },
        {
          publicAddress: "Address222222222222222222222222222222222",
          isActive: true,
        },
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deletes a wallet and promotes a replacement active wallet", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wallet-store-"));
    const store = new WalletStore(path.join(root, "wallets.sqlite"));

    try {
      await store.saveWallet(wallet());
      await store.saveWallet(wallet({
        publicAddress: "Address222222222222222222222222222222222",
        isActive: false,
      }));

      const newActive = await store.deleteWallet(
        "42",
        "Address111111111111111111111111111111111",
      );

      expect(newActive).toBe("Address222222222222222222222222222222222");
      expect(await store.getActivePublicAddress("42")).toBe(
        "Address222222222222222222222222222222222",
      );
      expect(await store.findWalletForUser(
        "42",
        "Address111111111111111111111111111111111",
      )).toBeNull();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
