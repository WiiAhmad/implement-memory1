// ═══════════════════════════════════════════════════════════════════════
//  [Step 32]  TELEGRAM BOT — Command Registration & Middleware
//  ═══════════════════════════════════════════════════════════════════════
//  Creates the grammy Bot instance with:
//    - Logging middleware (logs every update)
//    - /start command handler (help text)
//    - /verify command handler (force-issue verification code)
//    - /wallets-* command handlers (CRUD for Solana wallets)
//    - Text message handler (chat + verification flow)
//    - Error handling (catches GrammyError and HttpError)
// ═══════════════════════════════════════════════════════════════════════

import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";
import type { PrivateKeyAccessService } from "../wallets/private-key-access-service.ts";
import type { WalletService } from "../wallets/wallet-service.ts";
import { createTextHandler } from "./handler.ts";
import {
  createWalletsActiveHandler,
  createWalletsDeleteHandler,
  createWalletsGenHandler,
  createWalletsListHandler,
  createWalletsNowHandler,
  createWalletsPrivateKeyHandler,
} from "./wallet-command-handlers.ts";

export function createBot(deps: {
  token: string;
  logger: Logger;
  verificationService: VerificationService;
  chatService: ChatService;
  walletService: WalletService;
  privateKeyAccessService: PrivateKeyAccessService;
}) {
  const bot = new Bot(deps.token);

  // ─── Step 32a: Logging middleware — logs every incoming update ───────
  bot.use(async (ctx, next) => {
    deps.logger.info(`update=${ctx.update.update_id}`);
    await next();
  });

  // ─── Step 32b: /start command — show help text ──────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome!\n\n" +
      "Commands:\n" +
      "/verify - Get a fresh verification code (check server logs for the code)\n" +
      "/wallets-gen - Generate one Solana wallet and save it\n" +
      "/wallets-list - Show your saved wallet public addresses\n" +
      "/wallets-now - Show your active wallet\n" +
      "/wallets-active <public-address> - Change your active wallet\n" +
      "/wallets-delete <public-address> - Delete one saved wallet\n" +
      "/wallets-privatekey <public-address> - Request a code to reveal a private key\n" +
      "\n" +
      "If you're not verified yet, send any message to begin the one-time verification process.",
    );
  });

  // ─── Step 32c: /verify command — force-issue a fresh code ────────────
  bot.command("verify", async (ctx) => {
    if (!ctx.from) return;
    const identity = {
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    };
    try {
      const result = await deps.verificationService.issueFreshCode(identity);
      if (result.kind === "verified") {
        await ctx.reply("You are already verified. You can chat now.");
        return;
      }
      await ctx.reply(
        "A fresh verification code has been issued. Check the server logs for your code and send it here.",
      );
    } catch (error) {
      deps.logger.error(`[bot] /verify error: ${error instanceof Error ? error.message : String(error)}`);
      await ctx.reply("Failed to issue verification code. Please try again.");
    }
  });

  // ─── Step 32d: Create wallet command handler factories ───────────────
  const walletsGenHandler = createWalletsGenHandler({ walletService: deps.walletService });
  const walletsNowHandler = createWalletsNowHandler({ walletService: deps.walletService });
  const walletsListHandler = createWalletsListHandler({ walletService: deps.walletService });
  const walletsActiveHandler = createWalletsActiveHandler({ walletService: deps.walletService });
  const walletsDeleteHandler = createWalletsDeleteHandler({ walletService: deps.walletService });
  const walletsPrivateKeyHandler = createWalletsPrivateKeyHandler({ privateKeyAccessService: deps.privateKeyAccessService });

  // ─── Step 32e: Register /wallets-* command matchers ──────────────────
  bot.hears(/^\/wallets-gen(?:@\w+)?\s*$/i, async (ctx) => { await walletsGenHandler(ctx); });
  bot.hears(/^\/wallets-now(?:@\w+)?\s*$/i, async (ctx) => { await walletsNowHandler(ctx); });
  bot.hears(/^\/wallets-list(?:@\w+)?\s*$/i, async (ctx) => { await walletsListHandler(ctx); });
  bot.hears(/^\/wallets-active(?:@\w+)?(?:\s+(.+))?\s*$/i, async (ctx) => {
    await walletsActiveHandler({ from: ctx.from, match: ctx.match?.[1] ?? "", reply: (text) => ctx.reply(text) });
  });
  bot.hears(/^\/wallets-delete(?:@\w+)?(?:\s+(.+))?\s*$/i, async (ctx) => {
    await walletsDeleteHandler({ from: ctx.from, match: ctx.match?.[1] ?? "", reply: (text) => ctx.reply(text) });
  });
  bot.hears(/^\/wallets-privatekey(?:@\w+)?(?:\s+(.+))?\s*$/i, async (ctx) => {
    await walletsPrivateKeyHandler({ from: ctx.from, match: ctx.match?.[1] ?? "", reply: (text) => ctx.reply(text) });
  });

  // ─── Step 32f: Main text message handler (chat + verification) ──────
  bot.on("message:text", createTextHandler({
    verificationService: deps.verificationService,
    chatService: deps.chatService,
    privateKeyAccessService: deps.privateKeyAccessService,
    logger: deps.logger,
  }));

  // ─── Step 32g: Error handler ────────────────────────────────────────
  bot.catch((error) => {
    const e = error.error;
    if (e instanceof GrammyError) { deps.logger.error(`Telegram API error: ${e.description}`); return; }
    if (e instanceof HttpError) { deps.logger.error(`Telegram transport error: ${e.message}`); return; }
    deps.logger.error(`Unknown bot error: ${e instanceof Error ? e.message : String(e)}`);
  });

  return bot;
}
