// ═══════════════════════════════════════════════════════════════════════
//  [Step 4]  PATHS — Runtime Directory & File Path Resolution
//  ═══════════════════════════════════════════════════════════════════════
//  Centralizes ALL filesystem paths used by the Telegram bot.
//  Called by main.ts during startup to determine where data lives.
//  Supports both absolute and relative MEMORY_AGENT paths.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";

// ─── Step 4a: Type definition for all app paths ────────────────────────
export interface AppPaths {
  root: string;               // Root data directory (e.g., ./data/)
  authDir: string;            // data/auth/ — pending codes + verified users
  logsDir: string;            // data/logs/ — JSONL + verification logs
  memoryDir: string;          // data/memory-tdai/ — TDAI memory engine data
  walletsDir: string;         // data/wallets/ — wallet SQLite databases
  pendingCodesFile: string;   // data/auth/pending-codes.json
  verifiedUsersFile: string;  // data/auth/verified-users.json
  verificationLogFile: string;// data/logs/verification.log
  walletsDbFile: string;      // data/wallets/wallets.sqlite (primary)
  walletsBackupDbFile: string;// data/wallets/wallets-backup.sqlite (backup)
}

// ─── Step 4b: Resolve all paths from the data root ─────────────────────
//  If memoryRoot is absolute, use it directly.
//  If relative, resolve from the project root (2 levels up from src/utils/).
export function resolveDataPaths(memoryRoot: string): AppPaths {
  const projectRoot = path.resolve(import.meta.dir, "..", "..");
  const root = path.isAbsolute(memoryRoot)
    ? memoryRoot
    : path.resolve(projectRoot, memoryRoot);
  const authDir = path.join(root, "auth");
  const logsDir = path.join(root, "logs");
  const memoryDir = path.join(root, "memory-tdai");
  const walletsDir = path.join(root, "wallets");

  return {
    root,
    authDir,
    logsDir,
    memoryDir,
    walletsDir,
    pendingCodesFile: path.join(authDir, "pending-codes.json"),
    verifiedUsersFile: path.join(authDir, "verified-users.json"),
    verificationLogFile: path.join(logsDir, "verification.log"),
    walletsDbFile: path.join(walletsDir, "wallets.sqlite"),
    walletsBackupDbFile: path.join(walletsDir, "wallets-backup.sqlite"),
  };
}

// ─── Step 4c: Ensure all runtime directories exist ─────────────────────
//  Creates the full directory structure if it doesn't exist.
//  Called once at startup. Uses recursive mkdir which is idempotent.
export async function ensureRuntimeDirectories(paths: AppPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.authDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.walletsDir, { recursive: true });
}
