// ═══════════════════════════════════════════════════════════════════════
//  [Step 6]  CONSOLE LOGGER — stdout Logging with ISO Timestamps
//  ═══════════════════════════════════════════════════════════════════════
//  Creates a Logger implementation that writes formatted logs to console.
//  Format: "2026-05-26T12:34:56.789Z [telegram-bot] INFO message"
//  Used in combination with JSONL file logger for dual-output logging.
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

// ─── Step 6a: Format a log line with timestamp and prefix ──────────────
function format(level: string, message: string): string {
  return `${new Date().toISOString()} [telegram-bot] ${level} ${message}`;
}

// ─── Step 6b: Create a console-backed Logger ───────────────────────────
//  Implements the Logger interface from TDAI core types.
//  Supports: debug (console.debug), info (console.info),
//  warn (console.warn), error (console.error).
export function createLogger(): Logger {
  return {
    debug: (message) => console.debug(format("DEBUG", message)),
    info: (message) => console.info(format("INFO", message)),
    warn: (message) => console.warn(format("WARN", message)),
    error: (message) => console.error(format("ERROR", message)),
  };
}
