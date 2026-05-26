// ═══════════════════════════════════════════════════════════════════════
//  [Step 27]  PROMPT MODULE — Re-exports
//  ═══════════════════════════════════════════════════════════════════════
//  Barrel file that re-exports PromptBuilder, its config and types.
//  Used by ContextAgent to assemble the system + user + history messages
//  for each LLM call.
// ═══════════════════════════════════════════════════════════════════════

export { PromptBuilder, defaultPromptBuilder } from "./prompt-builder.ts";
export type {
  BuildPromptContext,
  BuildPromptResult,
  PromptBuilderConfig,
} from "./types.ts";
