// ═══════════════════════════════════════════════════════════════════════
//  [Step 18]  TENCENT MEMORY ADAPTER — TDAI Engine Wrapper
//  ═══════════════════════════════════════════════════════════════════════
//  Concrete implementation of MemoryAdapter backed by the
//  TencentDB-Agent-Memory engine (TDAI). Handles:
//  - Initialization (StandaloneHostAdapter + TdaiCore)
//  - Memory recall before each LLM turn
//  - Memory capture after each LLM turn
//  - Graceful shutdown via core.destroy()
// ═══════════════════════════════════════════════════════════════════════

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

  // ─── Step 18a: Factory — create TDAI engine and wire dependencies ─────
  //  1. Create StandaloneHostAdapter (standalone mode, no OpenClaw plugin)
  //  2. Parse full config from environment variables
  //  3. Initialize TdaiCore (L0 recorder, L1 extractor, persona, scenes, etc.)
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

  // ─── Step 18b: Recall memories before an LLM turn ───────────────────
  //  Delegates to TdaiCore.handleBeforeRecall() which runs:
  //  - BM25 keyword search for relevant memories
  //  - Persona/scene context assembly
  async recall(userKey: string, query: string): Promise<MemoryRecall> {
    const result = await this.core.handleBeforeRecall(query, userKey);
    return {
      prependContext: result.prependContext,
      appendSystemContext: result.appendSystemContext,
    };
  }

  // ─── Step 18c: Capture a completed turn into memory ─────────────────
  //  Builds a CompletedTurn object with user + assistant messages and
  //  delegates to TdaiCore.handleTurnCommitted() which triggers:
  //  - L0 recording (raw dialogue)
  //  - L1 extraction (structured memories)
  //  - Persona updates (every N conversations)
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

  // ─── Step 18d: Graceful shutdown ────────────────────────────────────
  async close(): Promise<void> {
    await this.core.destroy();
  }
}
