// ═══════════════════════════════════════════════════════════════════════
//  [Step 21]  OFFLOAD STORAGE — Session Key Mapping & Library Re-exports
//  ═══════════════════════════════════════════════════════════════════════
//  Provides:
//  1. Session key mapping: "tg:user:{id}" → "agent:telegram-bot:{id}"
//  2. Re-exports all library storage functions used by OffloadService
//  3. Thin convenience wrappers where needed
// ═══════════════════════════════════════════════════════════════════════

import type { PluginLogger, OffloadEntry } from "./types.ts";

// ─── Step 21a: Re-export all library storage functions ─────────────────
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

// ─── Step 21b: Agent name constant ────────────────────────────────────
//  Creates a dedicated subdirectory under the offload data root.
export const AGENT_NAME = "telegram-bot";

// ─── Step 21c: Convert Telegram session key → offload module format ───
//  The TDAI offload library expects "agent:<agent-name>:<session-id>".
//  Converts "tg:user:12345" to "agent:telegram-bot:12345".
export function toOffloadSessionKey(tgKey: string): string {
  const colonIdx = tgKey.indexOf(":");
  if (colonIdx === -1) {
    return `agent:${AGENT_NAME}:${tgKey}`;
  }

  const secondColonIdx = tgKey.indexOf(":", colonIdx + 1);
  if (secondColonIdx === -1) {
    const sessionId = tgKey.slice(colonIdx + 1);
    return `agent:${AGENT_NAME}:${sessionId}`;
  }

  // Extract everything after "tg:user:"
  const sessionId = tgKey.slice(secondColonIdx + 1);
  return `agent:${AGENT_NAME}:${sessionId}`;
}

// ─── Step 21d: Parse a Telegram key into offload agent + session ID ───
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

/** Get the agent name for the Telegram bot. */
export function getAgentName(): string {
  return AGENT_NAME;
}
