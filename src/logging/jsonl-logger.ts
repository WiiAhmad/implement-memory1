import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

export interface JsonlLoggerOptions {
  /** Directory where the .jsonl file will be written. */
  logsDir: string;
  /** File name (default: "telegram-bot.jsonl"). */
  fileName?: string;
  /** Max file size in bytes before rotation (default: 10 MB). 0 = no rotation. */
  maxSizeBytes?: number;
}

/** ISO date string in yyyy-mm-dd format. */
function todayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Creates a Logger that writes structured JSON lines to a file.
 *
 * Format (one JSON object per line):
 *   {"ts":"2026-05-21T12:34:56.789Z","level":"INFO","msg":"...","pid":1234}
 *
 * File rotation: when the current file exceeds `maxSizeBytes`, it is renamed
 * to `{name}.1.jsonl` and a new file is started. Older rotations are discarded.
 *
 * The default filename includes today's date (yyyy-mm-dd) so each day gets
 * its own file.
 */
export function createJsonlLogger(opts: JsonlLoggerOptions): Logger & { close(): Promise<void> } {
  const logsDir = opts.logsDir;
  const maxSize = opts.maxSizeBytes ?? 10 * 1024 * 1024; // 10 MB default
  const useDateRotation = !opts.fileName; // default naming = auto date-based rotation
  const pid = process.pid;

  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });

  let fd: number | null = null;
  let currentSize = 0;
  let currentDateStr = useDateRotation ? todayDateStr() : "";

  function getCurrentFileName(): string {
    if (useDateRotation) {
      return `${currentDateStr}-telegram-bot.jsonl`;
    }
    return opts.fileName!;
  }

  function getLogPath(): string {
    return path.join(logsDir, getCurrentFileName());
  }

  /**
   * If the date has changed since the last write, close the old fd
   * and switch to a new dated file.
   */
  function checkDateRotation(): void {
    if (!useDateRotation || fd === null) return;
    const newDate = todayDateStr();
    if (newDate === currentDateStr) return;

    // Close old fd — it's now on yesterday's file
    try { fs.closeSync(fd); } catch { /* ignore */ }
    fd = null;
    currentDateStr = newDate;
    currentSize = 0;
    // openFd() will open the new day's file
  }

  function openFd(): void {
    checkDateRotation();
    if (fd !== null) return;
    const logPath = getLogPath();
    try {
      fd = fs.openSync(logPath, "a");
      // Get current file size for rotation tracking
      try {
        currentSize = fs.statSync(logPath).size;
      } catch {
        currentSize = 0;
      }
    } catch {
      // Silently fall back to no file logging if we can't open
      fd = null;
    }
  }

  function rotateIfNeeded(): void {
    if (maxSize <= 0 || fd === null) return;
    if (currentSize < maxSize) return;

    const logPath = getLogPath();

    // Close current fd
    try { fs.closeSync(fd); } catch { /* ignore */ }
    fd = null;
    currentSize = 0;

    // Rotate: rename current → .1, discard older
    const rotatedPath = path.join(logsDir, `${path.basename(getCurrentFileName(), ".jsonl")}.1.jsonl`);
    try {
      fs.renameSync(logPath, rotatedPath);
    } catch {
      // If rename fails (e.g. file doesn't exist yet), just continue
    }

    // Open new file
    try {
      fd = fs.openSync(logPath, "a");
    } catch {
      fd = null;
    }
  }

  function write(level: string, message: string): void {
    openFd();
    if (fd === null) return;

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      pid,
    }) + "\n";

    rotateIfNeeded();

    try {
      const buf = Buffer.from(entry, "utf-8");
      fs.writeSync(fd, buf, 0, buf.length);
      currentSize += buf.length;
    } catch {
      // If write fails, try reopening on next call
      try { fs.closeSync(fd!); } catch { /* ignore */ }
      fd = null;
    }
  }

  /**
   * Flush any pending data and close the underlying file descriptor.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async function close(): Promise<void> {
    if (fd === null) return;
    try {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch { /* ignore */ }
    fd = null;
  }

  return {
    debug: (message) => write("DEBUG", message),
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    close,
  };
}
