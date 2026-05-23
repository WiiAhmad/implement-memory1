import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

/**
 * Combine multiple Logger instances into one that forwards every call
 * to all of them. Useful for logging to both console and file simultaneously.
 *
 * Each method (info, warn, error, debug) calls the corresponding method
 * on every logger in order.
 */
export function combineLoggers(...loggers: Logger[]): Logger {
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
  };
}
