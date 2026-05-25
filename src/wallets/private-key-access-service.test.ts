import { describe, expect, test } from "bun:test";
import { PrivateKeyAccessService } from "./private-key-access-service.ts";
import type { StoredWalletRecord, TelegramIdentity } from "./types.ts";

const identity: TelegramIdentity = {
  telegramUserId: "42",
  username: "terry",
  firstName: "Terry",
};

const wallet: StoredWalletRecord = {
  id: 1,
  telegramUserId: "42",
  publicAddress: "Address111111111111111111111111111111111",
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "PrivateKey111111111111111111111111111111111",
  createdAt: "2026-05-25T12:00:00.000Z",
  isActive: true,
};

class FakeWalletReader {
  found: StoredWalletRecord | null = wallet;

  async findWalletForUser(): Promise<StoredWalletRecord | null> {
    return this.found;
  }
}

describe("PrivateKeyAccessService", () => {
  test("issues a code for an owned wallet and logs it", async () => {
    const logs: string[] = [];
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: (message) => logs.push(message),
    });

    const result = await service.issueRequest(identity, wallet.publicAddress);

    expect(result).toEqual({
      kind: "issued",
      expiresAt: "2026-05-25T12:15:00.000Z",
    });
    expect(logs[0]).toContain("123456");
    expect(logs[0]).toContain(wallet.publicAddress);
    expect(logs[0]).not.toContain(wallet.privateKey);
  });

  test("reveals private key when the next message is the matching code", async () => {
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);
    const result = await service.consumeNextMessage(identity, "123456");
    const second = await service.consumeNextMessage(identity, "123456");

    expect(result).toEqual({
      kind: "revealed",
      publicAddress: wallet.publicAddress,
      privateKey: wallet.privateKey,
    });
    expect(second).toEqual({ kind: "none" });
  });

  test("cancels on wrong code", async () => {
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);

    expect(await service.consumeNextMessage(identity, "000000")).toEqual({
      kind: "canceled",
      reason: "wrong_code",
    });
    expect(await service.consumeNextMessage(identity, "123456")).toEqual({ kind: "none" });
  });

  test("cancels on unrelated next message", async () => {
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => new Date("2026-05-25T12:00:00.000Z"),
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);

    expect(await service.consumeNextMessage(identity, "hello bot")).toEqual({
      kind: "canceled",
      reason: "unexpected_message",
    });
  });

  test("cancels expired pending request", async () => {
    let now = new Date("2026-05-25T12:00:00.000Z");
    const service = new PrivateKeyAccessService({
      walletStore: new FakeWalletReader(),
      generateCode: () => "123456",
      now: () => now,
      appendLog: () => undefined,
    });

    await service.issueRequest(identity, wallet.publicAddress);
    now = new Date("2026-05-25T12:16:00.000Z");

    expect(await service.consumeNextMessage(identity, "123456")).toEqual({
      kind: "canceled",
      reason: "expired",
    });
  });
});
