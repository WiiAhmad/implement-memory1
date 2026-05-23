import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";

export interface TelegramTextContextLike {
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  message?: {
    text?: string;
  };
  reply(text: string): Promise<unknown>;
}

export function createTextHandler(deps: {
  verificationService: Pick<VerificationService, "isVerified" | "handleUnverifiedInput">;
  chatService: Pick<ChatService, "replyToUser">;
  logger?: Pick<Logger, "error">;
}) {
  return async function handleTextMessage(ctx: TelegramTextContextLike): Promise<void> {
    try {
      if (!ctx.from || !ctx.message?.text) return;

      const identity = {
        telegramUserId: String(ctx.from.id),
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      };
      const text = ctx.message.text.trim();
      if (!text) return;

      if (await deps.verificationService.isVerified(identity.telegramUserId)) {
        try {
          const reply = await deps.chatService.replyToUser({
            telegramUserId: ctx.from.id,
            text,
          });
          await ctx.reply(reply);
        } catch {
          await ctx.reply("Temporary error. Please try again in a moment.");
        }
        return;
      }

      const result = await deps.verificationService.handleUnverifiedInput(identity, text);

      if (result.kind === "verified") {
        await ctx.reply("Verification complete. You can chat now.");
        return;
      }

      if (result.kind === "invalid_code") {
        await ctx.reply("Invalid code. Check the server logs for the current code and try again.");
        return;
      }

      // Do NOT include the code in the Telegram reply — only the server logs show it.
      await ctx.reply(
        "Verification required. Check the server logs for your 6-digit code and send it here within 15 minutes.",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.logger?.error(`[handler] Unhandled error in text handler: ${msg}`);
      try {
        await ctx.reply("An internal error occurred. Please try again.");
      } catch { /* ignore reply errors */ }
    }
  };
}
