// ═══════════════════════════════════════════════════════════════════════
//  [Step 25]  PROMPT TYPES — LLM Prompt Assembly Type Definitions
//  ═══════════════════════════════════════════════════════════════════════
//  Types for the PromptBuilder pipeline: assembling LLM requests from
//  memory recall context, user input, and conversation history.
// ═══════════════════════════════════════════════════════════════════════

import type { ChatMessage } from "../openai/chat-client.ts";

// ─── Step 25a: Input context for building an LLM prompt ───────────────
export interface BuildPromptContext {
  /** Long-term memory context prepended to the user message (L1 relevant memories). */
  prependContext?: string;
  /** Stable system-side context (persona, scene navigation, tools guide). */
  appendSystemContext?: string;
  /** The user's current message text. */
  userText: string;
  /** Previous conversation messages (short-term turn history). */
  previousMessages?: ChatMessage[];
}

// ─── Step 25b: The fully assembled prompt parts ───────────────────────
export interface BuildPromptResult {
  /** System prompt (persona, scene nav, tools guide — cacheable). */
  systemPrompt?: string;
  /** The user message with prepended memory context. */
  userPrompt: string;
  /** Previous conversation messages to include for context. */
  previousMessages: ChatMessage[];
}

// ─── Step 25c: Configuration for PromptBuilder behaviour ──────────────
export interface PromptBuilderConfig {
  /** Separator between prependContext and userText. Default: "\n\n". */
  contextSeparator: string;
  /** Whether to trim whitespace from the final userPrompt. Default: true. */
  trimUserPrompt: boolean;
}
