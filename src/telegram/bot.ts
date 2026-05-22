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
    await ctx.reply("Hi. Send any message to begin the one-time verification flow.");
  });

  bot.on(
    "message:text",
    createTextHandler({
      verificationService: deps.verificationService,
      chatService: deps.chatService,
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
