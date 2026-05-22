import OpenAI from "openai";
import { JsonAuthStore } from "./auth/auth-store.ts";
import { VerificationService } from "./auth/verification-service.ts";
import { parseEnv } from "./config/env.ts";
import { createLogger } from "./logging/console-logger.ts";
import { TencentMemoryAdapter } from "./memory/tencent-memory-adapter.ts";
import { OpenAiChatClient } from "./openai/chat-client.ts";
import { ChatService } from "./services/chat-service.ts";
import { createBot } from "./telegram/bot.ts";
import { ensureRuntimeDirectories, resolveDataPaths } from "./utils/paths.ts";

export async function start(): Promise<void> {
  const env = parseEnv(process.env);
  const paths = resolveDataPaths(env.memoryRoot);
  const logger = createLogger();
  await ensureRuntimeDirectories(paths);

  const authStore = new JsonAuthStore(paths);
  const verificationService = new VerificationService({
    store: authStore,
    verificationLogFile: paths.verificationLogFile,
  });

  const memory = await TencentMemoryAdapter.create(env, paths, logger);
  const openai = new OpenAI({
    apiKey: env.openAIApiKey,
    baseURL: env.baseUrl,
  });
  const chatClient = new OpenAiChatClient(openai, env.model);
  const chatService = new ChatService({ memory, chatClient, logger });
  const bot = createBot({
    token: env.botToken,
    logger,
    verificationService,
    chatService,
  });

  let polling: Promise<void> | null = null;
  const shutdown = async () => {
    if (polling) {
      await bot.stop();
      await polling.catch(() => undefined);
    }
    await memory.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  logger.info("Starting Telegram bot with long polling");
  polling = bot.start();
  await polling;
}
