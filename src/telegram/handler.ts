// ═══════════════════════════════════════════════════════════════════════
//  [Step 33]  TELEGRAM TEXT HANDLER — Incoming Message Processing
//  ═══════════════════════════════════════════════════════════════════════
//  Handles all incoming text messages from Telegram users.
//
//  Flow per message:
//    1. Check if it's a private key code (consumeNextMessage)
//    2. If user is verified → delegate to ChatService.replyToUser()
//    3. If user is not verified → delegate to verification flow
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { VerificationService } from "../auth/verification-service.ts";
import type { ChatService } from "../services/chat-service.ts";
import type { PrivateKeyAccessService } from "../wallets/private-key-access-service.ts";

export interface TelegramTextContextLike {
  from?: { id: number; username?: string; first_name?: string };
  message?: { text?: string };
  reply(text: string): Promise<unknown>;
}

// ─── Step 33a: Create text handler factory ─────────────────────────────
export function createTextHandler(deps: {
  verificationService: Pick<VerificationService, "isVerified" | "handleUnverifiedInput">;
  chatService: Pick<ChatService, "replyToUser">;
  privateKeyAccessService?: Pick<PrivateKeyAccessService, "consumeNextMessage">;
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

      // ─── Step 33b: Check if this is a private key code ─────────────
      const privateKeyResult = await deps.privateKeyAccessService?.consumeNextMessage(identity, text);
      if (privateKeyResult?.kind === "revealed") {
        await ctx.reply(`Private key for ${privateKeyResult.publicAddress}:\n${privateKeyResult.privateKey}`);
        return;
      }
      if (privateKeyResult?.kind === "canceled") {
        await ctx.reply("Private key request canceled. Run /wallets-privatekey <public-address> to request a new code.");
        return;
      }

      // ─── Step 33c: If verified → chat with the LLM ────────────────
      if (await deps.verificationService.isVerified(identity.telegramUserId)) {
        try {
          const reply = await deps.chatService.replyToUser({ telegramUserId: ctx.from.id, text });
          await ctx.reply(reply);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          deps.logger?.error(`[handler] Chat reply failed: ${msg}`);
          await ctx.reply("Temporary error. Please try again in a moment.");
        }
        return;
      }

      // ─── Step 33d: If not verified → handle verification flow ────
      const result = await deps.verificationService.handleUnverifiedInput(identity, text);

      if (result.kind === "verified") {
        await ctx.reply("Verification complete. You can chat now.");
        return;
      }
      if (result.kind === "invalid_code") {
        await ctx.reply("Invalid code. Check the server logs for the current code and try again.");
        return;
      }
      // awaiting_code: code issued server-side, tell user to check logs
      await ctx.reply(
        "Verification required. Check the server logs for your 6-digit code and send it here within 15 minutes.",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.logger?.error(`[handler] Unhandled error in text handler: ${msg}`);
      try { await ctx.reply("An internal error occurred. Please try again."); } catch { /* ignore */ }
    }
  };
}
