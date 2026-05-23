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

/**
 * Creates a Logger that writes structured JSON lines to a file.
 *
 * Format (one JSON object per line):
 *   {"ts":"2026-05-21T12:34:56.789Z","level":"INFO","msg":"...","pid":1234}
 *
 * File rotation: when the current file exceeds `maxSizeBytes`, it is renamed
 * to `{name}.1.jsonl` and a new file is started. Older rotations are discarded.
 */
export function createJsonlLogger(opts: JsonlLoggerOptions): Logger {
  const fileName = opts.fileName ?? "telegram-bot.jsonl";
  const maxSize = opts.maxSizeBytes ?? 10 * 1024 * 1024; // 10 MB default
  const logPath = path.join(opts.logsDir, fileName);
  const pid = process.pid;

  // Ensure logs directory exists
  fs.mkdirSync(opts.logsDir, { recursive: true });

  let fd: number | null = null;
  let currentSize = 0;

  function openFd(): void {
    if (fd !== null) return;
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

    // Close current fd
    try {
      fs.closeSync(fd);
    } catch { /* ignore */ }
    fd = null;
    currentSize = 0;

    // Rotate: rename current → .1, discard older
    const rotatedPath = path.join(opts.logsDir, `${path.basename(fileName, ".jsonl")}.1.jsonl`);
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

  return {
    debug: (message) => write("DEBUG", message),
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
  };
}
