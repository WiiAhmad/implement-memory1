import type { ChatMessage } from "../openai/chat-client.ts";

/** Input context for building an LLM prompt from memory recall + user input + history. */
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

/** The fully assembled prompt parts ready to send to the chat client. */
export interface BuildPromptResult {
  /** System prompt (persona, scene nav, tools guide — cacheable). */
  systemPrompt?: string;
  /** The user message with prepended memory context. */
  userPrompt: string;
  /** Previous conversation messages to include for context. */
  previousMessages: ChatMessage[];
}

/** Configuration for PromptBuilder behaviour. */
export interface PromptBuilderConfig {
  /** Separator between prependContext and userText. Default: "\n\n". */
  contextSeparator: string;
  /** Whether to trim whitespace from the final userPrompt. Default: true. */
  trimUserPrompt: boolean;
}
