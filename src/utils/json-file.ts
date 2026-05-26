// ═══════════════════════════════════════════════════════════════════════
//  [Step 5]  JSON FILE UTILITIES — Atomic Read & Write for JSON Files
//  ═══════════════════════════════════════════════════════════════════════
//  Used by JsonAuthStore to persist pending codes and verified users.
//  Provides atomic writes via temp-file + rename pattern to prevent corruption.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";

// ─── Step 5a: Read JSON file with fallback ─────────────────────────────
//  If the file doesn't exist (ENOENT), return the fallback value.
//  Any other error (permissions, parse error) is thrown.
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

// ─── Step 5b: Atomically write JSON to file ────────────────────────────
//  1. Write to a temporary file (includes PID + timestamp to avoid collisions)
//  2. Rename temp → target (atomic on most filesystems)
//  This prevents partial writes from corrupting the target file.
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;

  await fs.writeFile(tempFilePath, text, "utf8");
  await fs.rename(tempFilePath, filePath);
}
