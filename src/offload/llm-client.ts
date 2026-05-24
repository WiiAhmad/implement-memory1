/**
 * LLM Client factory for the offload module.
 *
 * Wraps the TencentDB-Agent-Memory library's LocalLlmClient with the bot's
 * environment configuration (baseUrl, apiKey, model, temperature).
 *
 * The LocalLlmClient calls the LLM directly via the Vercel AI SDK
 * (`ai` + `@ai-sdk/openai`) for L1 summarization, L1.5 task judgment,
 * and L2 MMD generation.
 */
import { LocalLlmClient } from "../../TencentDB-Agent-Memory/src/offload/local-llm/index.ts";
import type { PluginLogger } from "./types.ts";

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

/**
 * Create a LocalLlmClient with the given configuration and logger.
 *
 * The LocalLlmClient is used for optional offload LLM tasks:
 * - L1: summarise tool call/result pairs into compact OffloadEntry entries
 * - L1.5: determine if the user's activity crosses a task boundary
 * - L2: generate Mermaid flowchart MMD files from offload entries
 *
 * Returns null if model or baseUrl is not configured.
 */
export function createLocalLlmClient(
  config: LlmClientConfig,
  logger?: PluginLogger,
): LocalLlmClient | null {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    logger?.warn?.("[offload] LocalLlmClient: missing baseUrl, apiKey, or model — not created");
    return null;
  }

  return new LocalLlmClient(
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature ?? 0.2,
      timeoutMs: 120_000,
    },
    logger,
  );
}
