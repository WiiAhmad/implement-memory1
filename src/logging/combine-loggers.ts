// ═══════════════════════════════════════════════════════════════════════
//  [Step 8]  COMBINE LOGGERS — Fan-out to Multiple Logger Instances
//  ═══════════════════════════════════════════════════════════════════════
//  Merges multiple Logger instances into one that forwards every call
//  to all of them. Used to log to both console AND file simultaneously.
//  Also aggregates close() calls for graceful shutdown.
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

/** Logger that can be gracefully closed (flushed + fd released). */
export interface ClosableLogger extends Logger {
  /** Flush pending writes and release any held resources. */
  close(): Promise<void>;
}

/**
 * Combine multiple Logger instances into one that forwards every call
 * to all of them. Useful for logging to both console and file simultaneously.
 *
 * If any of the loggers has a `close()` method, the combined logger also
 * exposes one that calls close on every sub-logger that supports it.
 *
 * Each method (info, warn, error, debug) calls the corresponding method
 * on every logger in order.
 */

// ─── Step 8a: Create a fan-out logger ──────────────────────────────────
//  For each log level, iterate through all sub-loggers and call the
//  corresponding method. The close() method aggregates close on any
//  sub-logger that supports the ClosableLogger interface.
export function combineLoggers(...loggers: Logger[]): ClosableLogger {
  return {
    debug: (message: string) => {
      for (const l of loggers) l.debug?.(message);
    },
    info: (message: string) => {
      for (const l of loggers) l.info(message);
    },
    warn: (message: string) => {
      for (const l of loggers) l.warn(message);
    },
    error: (message: string) => {
      for (const l of loggers) l.error(message);
    },
    close: async () => {
      for (const l of loggers) {
        const closable = l as Partial<ClosableLogger>;
        if (closable.close) {
          await closable.close();
        }
      }
    },
  };
}
