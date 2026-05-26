// ═══════════════════════════════════════════════════════════════════════
//  [Step 26]  PROMPT BUILDER — LLM Request Assembly
//  ═══════════════════════════════════════════════════════════════════════
//  Assembles LLM request parts from:
//    - prependContext (dynamic per-turn L1 memories) → merged into user prompt
//    - appendSystemContext (stable persona/scene/tools) → system prompt
//    - previousMessages (conversation history) → chat messages
//  Extend this class to customize prompt assembly (e.g., different separators,
//  injection rules, template wrappers).
// ═══════════════════════════════════════════════════════════════════════

import type { BuildPromptContext, BuildPromptResult, PromptBuilderConfig } from "./types.ts";

const DEFAULT_CONFIG: PromptBuilderConfig = {
  contextSeparator: "\n\n",
  trimUserPrompt: true,
};

// ─── Step 26a: PromptBuilder class ─────────────────────────────────────
export class PromptBuilder {
  protected readonly config: PromptBuilderConfig;

  constructor(config?: Partial<PromptBuilderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Step 26b: Build user prompt with prepended context ─────────────
  //  If prependContext is provided, it's joined with userText using
  //  the configured separator. Otherwise, raw userText is returned.
  buildUserPrompt(prependContext: string | undefined, userText: string): string {
    if (!prependContext) return this.config.trimUserPrompt ? userText.trim() : userText;
    const combined = [prependContext, userText].filter(Boolean).join(this.config.contextSeparator);
    return this.config.trimUserPrompt ? combined.trim() : combined;
  }

  // ─── Step 26c: Build the full prompt bundle ─────────────────────────
  //  Assembles systemPrompt, userPrompt, and previousMessages.
  //  Override this method to implement custom injection rules.
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
