// ═══════════════════════════════════════════════════════════════════════
//  [Step 1]  ENTRY POINT — Application Bootstrap
//  ═══════════════════════════════════════════════════════════════════════
//  This is the first file executed when the Telegram bot starts.
//  Flow: index.ts → src/main.ts → (config → logging → auth → memory → ...)
// ═══════════════════════════════════════════════════════════════════════

import { start } from "./src/main.ts";

// ─── Step 1a: Bootstrap the application ────────────────────────────────
//  Calls start() which wires all dependencies: env parsing, logger setup,
//  auth service, memory adapter, offload service, chat client, bot setup,
//  and begins long-polling for Telegram messages.
await start();
