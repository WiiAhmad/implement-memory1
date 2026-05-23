import type { BuildPromptContext, BuildPromptResult, PromptBuilderConfig } from "./types.ts";

const DEFAULT_CONFIG: PromptBuilderConfig = {
  contextSeparator: "\n\n",
  trimUserPrompt: true,
};

/**
 * Assembles LLM request parts from memory recall context, user input,
 * and conversation history.
 *
 * Separates concerns:
 * - **prependContext** (dynamic, per-turn L1 memories) → merged into user prompt
 * - **appendSystemContext** (stable persona/scene/tools) → passed as system prompt
 * - **previousMessages** (conversation history) → passed as chat messages
 *
 * Extend this class to customise prompt assembly (e.g. different separators,
 * injection rules, template wrappers).
 */
export class PromptBuilder {
  protected readonly config: PromptBuilderConfig;

  constructor(config?: Partial<PromptBuilderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Merge prependContext (long-term memories) with the user's raw text.
   * When prependContext is empty, returns the raw user text unchanged.
   */
  buildUserPrompt(prependContext: string | undefined, userText: string): string {
    if (!prependContext) return this.config.trimUserPrompt ? userText.trim() : userText;
    const combined = [prependContext, userText].filter(Boolean).join(this.config.contextSeparator);
    return this.config.trimUserPrompt ? combined.trim() : combined;
  }

  /**
   * Build the full prompt bundle from context.
   * Override this method to implement custom injection rules
   * (e.g. threshold-based injection, different system prompt composition).
   */
  build(ctx: BuildPromptContext): BuildPromptResult {
    const userPrompt = this.buildUserPrompt(ctx.prependContext, ctx.userText);
    return {
      systemPrompt: ctx.appendSystemContext || undefined,
      userPrompt,
      previousMessages: ctx.previousMessages ?? [],
    };
  }
}

/** Singleton default builder instance for simple use cases. */
export const defaultPromptBuilder = new PromptBuilder();
