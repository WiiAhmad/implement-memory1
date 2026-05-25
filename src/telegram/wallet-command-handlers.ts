import type { PrivateKeyAccessService } from "../wallets/private-key-access-service.ts";
import type { WalletService } from "../wallets/wallet-service.ts";

interface WalletCommandContextLike {
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  match?: string;
  reply(text: string): Promise<unknown>;
}

export function createWalletsGenHandler(deps: {
  walletService: Pick<WalletService, "createWallet">;
}) {
  return async function walletsGen(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const result = await deps.walletService.createWallet(String(ctx.from.id));
    if (result.kind === "limit_reached") {
      await ctx.reply(`Wallet limit reached. You can keep up to ${result.limit} wallets.`);
      return;
    }

    if (!result.backupSaved) {
      await ctx.reply(`Wallet created, but backup failed. Public address: ${result.publicAddress}`);
      return;
    }

    await ctx.reply(`Wallet created.\nPublic address: ${result.publicAddress}`);
  };
}

export function createWalletsNowHandler(deps: {
  walletService: Pick<WalletService, "getActivePublicAddress">;
}) {
  return async function walletsNow(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const publicAddress = await deps.walletService.getActivePublicAddress(String(ctx.from.id));
    if (!publicAddress) {
      await ctx.reply("No active wallet found.");
      return;
    }

    await ctx.reply(`Active wallet:\n${publicAddress}`);
  };
}

export function createWalletsListHandler(deps: {
  walletService: Pick<WalletService, "listWallets">;
}) {
  return async function walletsList(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const wallets = await deps.walletService.listWallets(String(ctx.from.id));
    if (wallets.length === 0) {
      await ctx.reply("No wallets found.");
      return;
    }

    const list = wallets
      .map((wallet, index) => {
        const marker = wallet.isActive ? " (active)" : "";
        return `${index + 1}. ${wallet.publicAddress}${marker}`;
      })
      .join("\n");
    await ctx.reply(`Wallets:\n${list}`);
  };
}

export function createWalletsActiveHandler(deps: {
  walletService: Pick<WalletService, "setActiveWallet">;
}) {
  return async function walletsActive(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const publicAddress = String(ctx.match ?? "").trim();
    if (!publicAddress) {
      await ctx.reply("Usage: /wallets-active <public-address>");
      return;
    }

    const result = await deps.walletService.setActiveWallet(String(ctx.from.id), publicAddress);
    if (result.kind === "not_found") {
      await ctx.reply("Wallet not found.");
      return;
    }

    if (!result.backupSaved) {
      await ctx.reply(`Active wallet changed, but backup failed. Active wallet:\n${result.publicAddress}`);
      return;
    }

    await ctx.reply(`Active wallet changed:\n${result.publicAddress}`);
  };
}

export function createWalletsDeleteHandler(deps: {
  walletService: Pick<WalletService, "deleteWallet">;
}) {
  return async function walletsDelete(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const publicAddress = String(ctx.match ?? "").trim();
    if (!publicAddress) {
      await ctx.reply("Usage: /wallets-delete <public-address>");
      return;
    }

    const result = await deps.walletService.deleteWallet(String(ctx.from.id), publicAddress);
    if (result.kind === "not_found") {
      await ctx.reply("Wallet not found.");
      return;
    }

    const activeLine = result.newActivePublicAddress
      ? `\nActive wallet:\n${result.newActivePublicAddress}`
      : "\nNo active wallet remains.";

    if (!result.backupSaved) {
      await ctx.reply(`Wallet deleted, but backup failed.${activeLine}`);
      return;
    }

    await ctx.reply(`Wallet deleted.${activeLine}`);
  };
}

export function createWalletsPrivateKeyHandler(deps: {
  privateKeyAccessService: Pick<PrivateKeyAccessService, "issueRequest">;
}) {
  return async function walletsPrivateKey(ctx: WalletCommandContextLike): Promise<void> {
    if (!ctx.from) return;

    const publicAddress = String(ctx.match ?? "").trim();
    if (!publicAddress) {
      await ctx.reply("Usage: /wallets-privatekey <public-address>");
      return;
    }

    const result = await deps.privateKeyAccessService.issueRequest({
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    }, publicAddress);

    if (result.kind === "not_found") {
      await ctx.reply("Wallet not found.");
      return;
    }

    await ctx.reply(
      "Private key access code issued. Check server logs and send the 6-digit code as your next message within 15 minutes.",
    );
  };
}
