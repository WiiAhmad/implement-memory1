// ═══════════════════════════════════════════════════════════════════════
//  [Step 2]  MAIN STARTUP — Dependency Wiring & Service Initialization
//  ═══════════════════════════════════════════════════════════════════════
//  Called from index.ts. This function orchestrates ALL service creation:
//  config → logging → auth → wallets → memory → openai → tools →
//  offload → chat service → telegram bot → polling loop.
// ═══════════════════════════════════════════════════════════════════════

import { JsonAuthStore } from "./auth/auth-store.ts";
import { VerificationService } from "./auth/verification-service.ts";
import { parseEnv } from "./config/env.ts";
import { createLogger } from "./logging/console-logger.ts";
import { createJsonlLogger } from "./logging/jsonl-logger.ts";
import { combineLoggers } from "./logging/combine-loggers.ts";
import { TencentMemoryAdapter } from "./memory/tencent-memory-adapter.ts";
import { OffloadService } from "./offload/index.ts";
import { OpenAiChatClient } from "./openai/chat-client.ts";
import { ChatService } from "./services/chat-service.ts";
import { ToolHandler } from "./tools/tool-handler.ts";
import { createBot } from "./telegram/bot.ts";
import { ensureRuntimeDirectories, resolveDataPaths } from "./utils/paths.ts";
import { PrivateKeyAccessService } from "./wallets/private-key-access-service.ts";
import { WalletService } from "./wallets/wallet-service.ts";
import { WalletStore } from "./wallets/wallet-store.ts";

export async function start(): Promise<void> {
  // ─── Step 2a: Parse environment variables ──────────────────────────────
  //  Reads .env / process.env via Zod schema validation.
  //  All config lives in src/config/env.ts — if parsing fails, app exits.
  const env = parseEnv(process.env);
  // ─── Step 2b: Resolve all runtime directory paths ──────────────────────
  //  Constructs absolute paths for auth, logs, memory, wallets dirs.
  const paths = resolveDataPaths(env.memoryRoot);

  // ─── Step 2c: Create dual loggers (console + JSONL file) ──────────────
  //  Console logger → stdout for dev visibility.
  //  File logger → structured .jsonl for production debugging.
  const consoleLogger = createLogger();
  const fileLogger = createJsonlLogger({ logsDir: paths.logsDir });
  const logger = combineLoggers(consoleLogger, fileLogger);

  // ─── Step 2d: Ensure all runtime directories exist on disk ─────────────
  //  Creates: data/, data/auth/, data/logs/, data/memory-tdai/, data/wallets/
  await ensureRuntimeDirectories(paths);

  // ─── Step 2e: Initialize Auth Store + Verification Service ────────────
  //  Auth store reads/writes JSON files for pending codes and verified users.
  //  Verification service handles 6-digit code flow for Telegram access.
  const authStore = new JsonAuthStore(paths);
  const verificationService = new VerificationService({
    store: authStore,
    verificationLogFile: paths.verificationLogFile,
    logger,
  });

  // ─── Step 2f: Initialize Wallet Stores + Wallet Service ────────────────
  //  Primary store = main SQLite DB for wallet data.
  //  Backup store = separate SQLite DB for disaster recovery.
  //  Wallet service orchestrates create/list/activate/delete operations.
  const primaryWalletStore = new WalletStore(paths.walletsDbFile);
  const backupWalletStore = new WalletStore(paths.walletsBackupDbFile);
  const walletService = new WalletService({
    primaryStore: primaryWalletStore,
    backupStore: backupWalletStore,
    logger,
  });

  // ─── Step 2g: Initialize Private Key Access Service ───────────────────
  //  Handles the 6-digit code flow for revealing wallet private keys.
  const privateKeyAccessService = new PrivateKeyAccessService({
    walletStore: primaryWalletStore,
    verificationLogFile: paths.verificationLogFile,
    logger,
  });

  // ─── Step 2h: Initialize Memory Adapter (TencentDB-Agent-Memory) ───────
  //  Wraps the TDAI core: L0 recording, L1 extraction, persona, scene nav.
  //  Powers recall (before LLM) and capture (after LLM) for each turn.
  const memory = await TencentMemoryAdapter.create(env, paths, logger);

  // ─── Step 2i: Initialize OpenAI Chat Client ────────────────────────────
  //  Wraps the OpenAI SDK with a manual step loop for tool call handling.
  //  Used for ALL LLM replies to the user.
  const chatClient = new OpenAiChatClient({
    baseUrl: env.baseUrl,
    apiKey: env.openAIApiKey,
    model: env.model,
    timeoutMs: env.chatTimeoutMs,
    timeoutRetries: env.chatTimeoutRetries,
  }, logger);

  // ─── Step 2j: Wire memory search tools for the LLM ─────────────────────
  //  Exposes tdai_memory_search + tdai_conversation_search as callable tools.
  //  The LLM can proactively search memories during a conversation turn.
  const toolHandler = new ToolHandler({ core: memory.getCore(), logger });

  // ─── Step 2k: Initialize Offload Service (optional) ───────────────────
  //  Context compression engine: L3 (inline), L1 (summarization),
  //  L1.5 (task boundaries), L2 (MMD generation).
  //  Only active when OFFLOAD_ENABLED=true.
  const offloadConfig = {
    ...env.offload,
    model: env.offload.model || env.model,
  };
  const offloadService = env.offload.enabled
    ? new OffloadService({
        enabled: true,
        config: offloadConfig,
        logger,
        getDataDir: () => paths.memoryDir,
        baseUrl: env.baseUrl,
        apiKey: env.openAIApiKey,
      })
    : undefined;

  // ─── Step 2l: Create Chat Service ──────────────────────────────────────
  //  Manages per-user conversation histories with LRU eviction (max 500 users).
  //  Delegates per-turn logic to ContextAgent (recall → prompt → LLM → capture).
  const chatService = new ChatService({ memory, chatClient, logger, toolHandler, offloadService });

  // ─── Step 2m: Create Telegram Bot ──────────────────────────────────────
  //  grammy Bot instance with command handlers (/start, /verify, /wallets-*)
  //  and the main text message handler for chat + verification.
  const bot = createBot({
    token: env.botToken,
    logger,
    verificationService,
    chatService,
    walletService,
    privateKeyAccessService,
  });

  // ─── Step 2n: Graceful Shutdown Handler ────────────────────────────────
  //  Catches SIGINT/SIGTERM → stops bot polling, closes offload sessions,
  //  closes wallet DBs, flushes memory engine, closes loggers, exits.
  let polling: Promise<void> | null = null;
  const shutdown = async () => {
    if (polling) {
      await bot.stop();
      await polling.catch(() => undefined);
    }
    if (offloadService) {
      await offloadService.close();
    }
    primaryWalletStore.close();
    backupWalletStore.close();
    await memory.close();
    await logger.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // ─── Step 2o: Start Long-Polling ───────────────────────────────────────
  //  Begins the Telegram bot's long-polling loop.
  //  This promise never resolves under normal operation (runs until shutdown).
  logger.info("Starting Telegram bot with long polling");
  polling = bot.start();
  await polling;
}
