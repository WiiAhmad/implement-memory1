import { StandaloneHostAdapter } from "../../TencentDB-Agent-Memory/src/adapters/standalone/host-adapter.ts";
import { parseConfig } from "../../TencentDB-Agent-Memory/src/config.ts";
import { TdaiCore } from "../../TencentDB-Agent-Memory/src/core/tdai-core.ts";
import type { CompletedTurn, Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { AppEnv } from "../config/env.ts";
import type { AppPaths } from "../utils/paths.ts";
import { buildTdaiRawConfig } from "./build-memory-config.ts";
import type { MemoryAdapter, MemoryRecall } from "./types.ts";

export class TencentMemoryAdapter implements MemoryAdapter {
  constructor(private readonly core: TdaiCore) {}

  static async create(env: AppEnv, paths: AppPaths, logger: Logger): Promise<TencentMemoryAdapter> {
    const hostAdapter = new StandaloneHostAdapter({
      dataDir: paths.memoryDir,
      llmConfig: {
        baseUrl: env.baseUrl,
        apiKey: env.openAIApiKey,
        model: env.model,
        maxTokens: 4096,
        timeoutMs: 120000,
      },
      logger,
      defaultUserId: "telegram-user",
      platform: "telegram",
    });

    const config = parseConfig(buildTdaiRawConfig(env));
    const core = new TdaiCore({ hostAdapter, config });
    await core.initialize();
    return new TencentMemoryAdapter(core);
  }

  async recall(userKey: string, query: string): Promise<MemoryRecall> {
    const result = await this.core.handleBeforeRecall(query, userKey);
    return {
      prependContext: result.prependContext,
      appendSystemContext: result.appendSystemContext,
    };
  }

  async capture(userKey: string, userText: string, assistantText: string): Promise<void> {
    const startedAt = Date.now();
    const turn: CompletedTurn = {
      userText,
      assistantText,
      sessionKey: userKey,
      startedAt,
      messages: [
        {
          id: `user-${startedAt}`,
          role: "user",
          content: userText,
          timestamp: startedAt,
        },
        {
          id: `assistant-${startedAt + 1}`,
          role: "assistant",
          content: assistantText,
          timestamp: startedAt + 1,
        },
      ],
    };

    await this.core.handleTurnCommitted(turn);
  }

  /** Expose the underlying TdaiCore for tool execution and advanced access. */
  getCore(): TdaiCore {
    return this.core;
  }

  async close(): Promise<void> {
    await this.core.destroy();
  }
}
