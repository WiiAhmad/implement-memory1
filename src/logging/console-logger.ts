import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";

function format(level: string, message: string): string {
  return `${new Date().toISOString()} [telegram-bot] ${level} ${message}`;
}

export function createLogger(): Logger {
  return {
    debug: (message) => console.debug(format("DEBUG", message)),
    info: (message) => console.info(format("INFO", message)),
    warn: (message) => console.warn(format("WARN", message)),
    error: (message) => console.error(format("ERROR", message)),
  };
}
