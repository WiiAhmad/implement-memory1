// ═══════════════════════════════════════════════════════════════════════
//  [Step 22]  OFFLOAD LLM CLIENT — Factory for LocalLlmClient
//  ═══════════════════════════════════════════════════════════════════════
//  Creates a LocalLlmClient instance for offload LLM tasks:
//  - L1: Summarize tool call/result pairs into compact OffloadEntry entries
//  - L1.5: Determine if user activity crosses a task boundary
//  - L2: Generate Mermaid flowchart MMD files from offload entries
// ═══════════════════════════════════════════════════════════════════════

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
 * Returns null if model or baseUrl is not configured.
 */

// ─── Step 22a: Factory function ────────────────────────────────────────
//  Validates required config fields before creating the client.
//  If any required field (baseUrl, apiKey, model) is missing, returns null.
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
