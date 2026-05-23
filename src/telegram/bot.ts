import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";
import { createTextHandler } from "./handler.ts";

export function createBot(deps: {
  token: string;
  logger: Logger;
  verificationService: VerificationService;
  chatService: ChatService;
}) {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    deps.logger.info(`update=${ctx.update.update_id}`);
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome!\n\n" +
      "Commands:\n" +
      "/verify — Get a fresh verification code (check server logs for the code)\n" +
      "\n" +
      "If you're not verified yet, send any message to begin the one-time verification process.",
    );
  });

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
        "A fresh verification code has been issued. Check the server logs for your 6-digit code and send it here.",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.logger.error(`[bot] /verify error: ${msg}`);
      await ctx.reply("Failed to issue verification code. Please try again.");
    }
  });

  bot.on(
    "message:text",
    createTextHandler({
      verificationService: deps.verificationService,
      chatService: deps.chatService,
      logger: deps.logger,
    }),
  );

  bot.catch((error) => {
    const e = error.error;
    if (e instanceof GrammyError) {
      deps.logger.error(`Telegram API error: ${e.description}`);
      return;
    }
    if (e instanceof HttpError) {
      deps.logger.error(`Telegram transport error: ${e.message}`);
      return;
    }
    deps.logger.error(`Unknown bot error: ${e instanceof Error ? e.message : String(e)}`);
  });

  return bot;
}
