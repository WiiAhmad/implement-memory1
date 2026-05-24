/**
 * Storage wrapper for the offload module.
 *
 * Provides:
 * 1. Session key mapping: "tg:user:{id}" → "agent:telegram-bot:{id}"
 * 2. Re-exports all library storage functions used by the bot
 * 3. Thin convenience wrappers where needed
 */
import type { PluginLogger, OffloadEntry } from "./types.ts";

// ─── Library imports ────────────────────────────────────────────────────

export {
  createStorageContext,
  readOffloadEntries,
  appendOffloadEntries,
  readAllOffloadEntries,
  markOffloadStatus,
  writeMmd,
  readMmd,
  listMmds,
  deleteMmd,
  ensureDirs,
  registerSession,
  lookupSessionId,
  listRegisteredSessions,
  updateOffloadNodeIds,
  rewriteAllOffloadEntries,
  patchMmd,
  writeRefMd,
  sanitizeText,
} from "../../TencentDB-Agent-Memory/src/offload/storage.ts";

export type { StorageContext } from "../../TencentDB-Agent-Memory/src/offload/storage.ts";

// ─── Agent name constant ────────────────────────────────────────────────

/**
 * The agent name used in offload session keys.
 * This creates a dedicated subdirectory under the offload data root.
 */
export const AGENT_NAME = "telegram-bot";

// ─── Session Key Mapping ────────────────────────────────────────────────

/**
 * Convert a Telegram session key (e.g., "tg:user:12345") to the offload
 * module's expected format ("agent:telegram-bot:12345").
 *
 * The offload library's parseSessionKey() expects:
 *   "agent:<agent-name>:<session-id>"
 */
export function toOffloadSessionKey(tgKey: string): string {
  // tg:user:12345 → extract userId portion after "tg:user:"
  // Also handles "tg:user:abc" and similar formats
  const colonIdx = tgKey.indexOf(":");
  if (colonIdx === -1) {
    // Not a valid tg key format — wrap as-is
    return `agent:${AGENT_NAME}:${tgKey}`;
  }

  const secondColonIdx = tgKey.indexOf(":", colonIdx + 1);
  if (secondColonIdx === -1) {
    // Only one colon — treat remaining as sessionId
    const sessionId = tgKey.slice(colonIdx + 1);
    return `agent:${AGENT_NAME}:${sessionId}`;
  }

  // Extract everything after "tg:user:"
  const sessionId = tgKey.slice(secondColonIdx + 1);
  return `agent:${AGENT_NAME}:${sessionId}`;
}

/**
 * Resolve a Telegram session key to parsed offload agent name and session ID.
 * Returns null if the key format is invalid.
 *
 * Parses "agent:<agent-name>:<session-id>" format produced by toOffloadSessionKey().
 * This is a standalone implementation to avoid re-export issues with the library's
 * module (which uses .js extension imports internally).
 */
export function resolveSessionKey(
  tgKey: string,
): { agentName: string; sessionId: string } | null {
  const offloadKey = toOffloadSessionKey(tgKey);
  const parts = offloadKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1]) return null;
  const sessionId = parts.slice(2).join(":");
  if (!sessionId) return null;
  return { agentName: parts[1], sessionId };
}

/**
 * Get the agent name for the Telegram bot.
 */
export function getAgentName(): string {
  return AGENT_NAME;
}
