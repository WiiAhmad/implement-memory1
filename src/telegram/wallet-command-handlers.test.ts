import { describe, expect, test } from "bun:test";
import {
  createWalletsActiveHandler,
  createWalletsDeleteHandler,
  createWalletsGenHandler,
  createWalletsListHandler,
  createWalletsNowHandler,
  createWalletsPrivateKeyHandler,
} from "./wallet-command-handlers.ts";

function createCtx(match = "") {
  const replies: string[] = [];

  return {
    ctx: {
      from: {
        id: 42,
        username: "terry",
        first_name: "Terry",
      },
      match,
      reply: async (message: string) => {
        replies.push(message);
      },
    },
    replies,
  };
}

describe("wallet command handlers", () => {
  test("/wallets-gen replies with only the public address", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsGenHandler({
      walletService: {
        createWallet: async () => ({
          kind: "created" as const,
          publicAddress: "Address111",
          backupSaved: true,
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Wallet created.\nPublic address: Address111"]);
  });

  test("/wallets-gen reports max wallet limit", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsGenHandler({
      walletService: {
        createWallet: async () => ({
          kind: "limit_reached" as const,
          limit: 10,
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Wallet limit reached. You can keep up to 10 wallets."]);
  });

  test("/wallets-list lists public addresses and marks active wallet", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsListHandler({
      walletService: {
        listWallets: async () => [
          { publicAddress: "Address111", isActive: true },
          { publicAddress: "Address222", isActive: false },
        ],
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Wallets:\n1. Address111 (active)\n2. Address222"]);
  });

  test("/wallets-now shows only the active wallet", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsNowHandler({
      walletService: {
        getActivePublicAddress: async () => "Address111",
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Active wallet:\nAddress111"]);
  });

  test("/wallets-now handles missing active wallet", async () => {
    const { ctx, replies } = createCtx();
    const handler = createWalletsNowHandler({
      walletService: {
        getActivePublicAddress: async () => null,
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["No active wallet found."]);
  });

  test("/wallets-active changes active wallet", async () => {
    const { ctx, replies } = createCtx("Address222");
    const handler = createWalletsActiveHandler({
      walletService: {
        setActiveWallet: async () => ({
          kind: "activated" as const,
          publicAddress: "Address222",
          backupSaved: true,
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Active wallet changed:\nAddress222"]);
  });

  test("/wallets-delete deletes wallet", async () => {
    const { ctx, replies } = createCtx("Address222");
    const handler = createWalletsDeleteHandler({
      walletService: {
        deleteWallet: async () => ({
          kind: "deleted" as const,
          publicAddress: "Address222",
          newActivePublicAddress: "Address111",
          backupSaved: true,
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Wallet deleted.\nActive wallet:\nAddress111"]);
  });

  test("/wallets-privatekey requires address", async () => {
    const { ctx, replies } = createCtx("");
    const handler = createWalletsPrivateKeyHandler({
      privateKeyAccessService: {
        issueRequest: async () => ({ kind: "issued" as const, expiresAt: "unused" }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Usage: /wallets-privatekey <public-address>"]);
  });

  test("/wallets-privatekey starts code flow for owned wallet", async () => {
    const { ctx, replies } = createCtx("Address111");
    const handler = createWalletsPrivateKeyHandler({
      privateKeyAccessService: {
        issueRequest: async () => ({
          kind: "issued" as const,
          expiresAt: "2026-05-25T12:15:00.000Z",
        }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual([
      "Private key access code issued. Check server logs and send the 6-digit code as your next message within 15 minutes.",
    ]);
  });

  test("/wallets-privatekey hides unknown and unowned wallets", async () => {
    const { ctx, replies } = createCtx("Address111");
    const handler = createWalletsPrivateKeyHandler({
      privateKeyAccessService: {
        issueRequest: async () => ({ kind: "not_found" as const }),
      },
    });

    await handler(ctx as never);

    expect(replies).toEqual(["Wallet not found."]);
  });
});
