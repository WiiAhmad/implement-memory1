// ═══════════════════════════════════════════════════════════════════════
//  [Step 45]  ADMIN HANDLERS — /memory-status and /offload-status Commands
//  ═══════════════════════════════════════════════════════════════════════
//  Admin-only Telegram commands for inspecting memory pipeline and offload
//  service state. All commands check admin identity before responding.
//  Status output redacts raw message content per spec Section 10.2.
// ═══════════════════════════════════════════════════════════════════════

import { Bot } from "grammy";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { MemoryAutonomyCheckpoint } from "../memory/autonomy-checkpoint.ts";
import type { OffloadService } from "../offload/index.ts";
import type { CoordinationService } from "../services/coordination.ts";

export interface AdminHandlerDeps {
  logger: Logger;
  isAdmin: (userId: number) => boolean;
  isSuperAdmin: (userId: number) => boolean;
  memoryCheckpoint: MemoryAutonomyCheckpoint;
  offloadService?: OffloadService;
  coordination?: CoordinationService;
  /** Memory data directory (used by offload status for reading entries). */
  dataDir: string;
}

// ── Register all admin commands on a bot instance ──────────────────────
export function registerAdminHandlers(bot: Bot, deps: AdminHandlerDeps): void {
  // ─── /memory-status — Show memory pipeline state ─────────────────────
  bot.command("memory-status", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Access denied.");
      deps.logger.info(`[admin] /memory-status denied user=${userId}`);
      return;
    }

    try {
      const lines: string[] = ["Memory:\n"];

      // Determine scope: self (default) or all if super-admin
      const sessionKey = `tg:user:${userId}`;
      const allStates = await deps.memoryCheckpoint.getAllStates();

      if (allStates[sessionKey]) {
        const state = allStates[sessionKey]!;
        lines.push(`- Last L1: ${state.lastL1CompletedAt ?? "never"}`);
        lines.push(`- Last L2: ${state.lastL2CompletedAt ?? "never"}`);
        lines.push(`- L2 seq processed: ${state.lastMemorySeqProcessedByL2} / L1 seq extracted: ${state.lastMemorySeqExtracted}`);
        lines.push(`- Persona updated: ${state.lastPersonaAt ?? "never"}`);
        if (state.lastPersonaAt) {
          const ageHours = ((Date.now() - new Date(state.lastPersonaAt).getTime()) / 3_600_000).toFixed(1);
          lines.push(`- Persona age: ${ageHours} hours`);
          lines.push(`- Persona stale: ${parseFloat(ageHours) >= 24 ? "yes" : "no"}`);
        } else {
          lines.push(`- Persona stale: N/A`);
        }
        lines.push(`- L2 job status: ${state.l2JobStatus}`);
        lines.push(`- Last meaningful memory: ${state.lastMeaningfulMemoryAt ?? "never"}`);
        lines.push(`- Scene index updated: ${state.sceneIndexUpdatedAt ?? "never"}`);
        lines.push(``);
        lines.push(`Checkpoint:`);
        lines.push(`- pending_l1_count: ${Math.max(0, state.lastMemorySeqExtracted - state.lastMemorySeqProcessedByL2)}`);
        lines.push(`- lastMemorySeqProcessedByL2: ${state.lastMemorySeqProcessedByL2}`);
        lines.push(`- lastSceneSeqProcessedByPersona: ${state.lastSceneSeqProcessedByPersona}`);
        lines.push(`- sessionIsCold: ${state.sessionIsCold ? "yes" : "no"}`);
      } else {
        lines.push(`No memory state found for your session.`);
      }

      // Session count (always shown, no raw content)
      const sessionCount = Object.keys(allStates).length;
      lines.push(``);
      lines.push(`Tracked sessions: ${sessionCount}`);

      // Cross-system coordination metrics (Phase 5)
      if (deps.coordination) {
        const metrics = deps.coordination.getMetrics();
        lines.push(``);
        lines.push(`Cross-system:`);
        lines.push(`- Resolved scenes from MMD: ${metrics.resolvedScenesFromMmd}`);
        lines.push(`- MMD names from scenes: ${metrics.mmdNamesFromScenes}`);
        lines.push(`- Context injections before compression: ${metrics.contextInjections}`);
      }

      await ctx.reply(lines.join("\n"));
      deps.logger.info(`[admin] /memory-status ok user=${userId} sessions=${sessionCount}`);
    } catch (err) {
      deps.logger.error(`[admin] /memory-status error: ${err}`);
      await ctx.reply("Error retrieving memory status.");
    }
  });

  // ─── /offload-reclaim — Run offload data retention reclaim ──────────
  //  Requires --confirm flag to proceed (destructive operation).
  //  Only reclaims if OFFLOAD_RECLAIM_ENABLED=true and retentionDays >= 3.
  bot.command("offload-reclaim", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Access denied.");
      deps.logger.info(`[admin] /offload-reclaim denied user=${userId}`);
      return;
    }

    const text = ctx.message?.text ?? "";
    const hasConfirm = text.includes("--confirm");

    if (!hasConfirm) {
      await ctx.reply(
        "This command will permanently delete old offload data files.\n" +
        "To confirm, run: `/offload-reclaim --confirm`\n\n" +
        "This is a destructive operation — deleted files cannot be recovered.",
      );
      deps.logger.info(`[admin] /offload-reclaim requires --confirm user=${userId}`);
      return;
    }

    if (!deps.offloadService) {
      await ctx.reply("Offload service is not available.");
      deps.logger.info(`[admin] /offload-reclaim no-service user=${userId}`);
      return;
    }

    try {
      deps.logger.info(`[admin] /offload-reclaim --confirm user=${userId}`);
      const stats = await deps.offloadService.runReclaim();
      if (!stats) {
        await ctx.reply(
          "Reclaim did not run. Possible reasons:\n" +
          "- OFFLOAD_RECLAIM_ENABLED is false\n" +
          "- OFFLOAD_RETENTION_DAYS < 3\n" +
          "- Offload is disabled",
        );
        return;
      }

      const lines = [
        "Offload data reclaim completed:",
        "",
        `- JSONL files deleted: ${stats.deletedJsonl}`,
        `- Ref MD files deleted: ${stats.deletedRefs}`,
        `- MMD files deleted: ${stats.deletedMmds}`,
        `- Log files truncated: ${stats.truncatedLogs}`,
        `- Registry entries pruned: ${stats.prunedRegistryEntries}`,
      ];
      await ctx.reply(lines.join("\n"));
      deps.logger.info(`[admin] /offload-reclaim ok user=${userId} stats=${JSON.stringify(stats)}`);
    } catch (err) {
      deps.logger.error(`[admin] /offload-reclaim error: ${err}`);
      await ctx.reply("Error running offload reclaim.");
    }
  });

  // ─── /offload-status — Show offload service state ───────────────────
  bot.command("offload-status", async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Access denied.");
      deps.logger.info(`[admin] /offload-status denied user=${userId}`);
      return;
    }

    try {
      const lines: string[] = ["Offload:\n"];

      if (!deps.offloadService) {
        lines.push("- Enabled: no");
        lines.push("- Offload is disabled or not configured.");
        await ctx.reply(lines.join("\n"));
        return;
      }

      // Offload status is gathered from the OffloadService.
      // We read offload session state via the storage module.
      const { readAllOffloadEntries, toOffloadSessionKey } = await import("../offload/storage.ts");

      const sessionKey = `tg:user:${userId}`;
      const offloadKey = toOffloadSessionKey(sessionKey);

      lines.push(`- Enabled: yes`);

      // Count offload entries
      try {
        const allEntries = await readAllOffloadEntries({ dataDir: deps.dataDir } as any, deps.logger);
        const sessionEntries = allEntries.filter((e: any) => e.sessionKey === offloadKey || e.timestamp);
        lines.push(`- Offload entries: ${sessionEntries.length}`);
        const nullEntries = sessionEntries.filter((e: any) => e.node_id === null || e.node_id === undefined);
        lines.push(`- Null node entries: ${nullEntries.length}`);
      } catch {
        lines.push(`- Offload entries: (unavailable)`);
        lines.push(`- Null node entries: (unavailable)`);
      }

      lines.push(`- Active MMD: (offload storage — check logs for latest L2)`);
      lines.push(`- L3 compression: (tracked per-turn in logs)`);

      await ctx.reply(lines.join("\n"));
      deps.logger.info(`[admin] /offload-status ok user=${userId}`);
    } catch (err) {
      deps.logger.error(`[admin] /offload-status error: ${err}`);
      await ctx.reply("Error retrieving offload status.");
    }
  });
}
