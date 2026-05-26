// ═══════════════════════════════════════════════════════════════════════
//  [Step 36]  AGENT MODULE — Re-exports
//  ═══════════════════════════════════════════════════════════════════════
//  Barrel file that re-exports ContextAgent and its associated types.
//  Imported by src/services/chat-service.ts when wiring the per-turn
//  pipeline.
// ═══════════════════════════════════════════════════════════════════════

export { ContextAgent } from "./context-agent.ts";
export type {
  ContextAgentOptions,
  ContextAgentReplyParams,
  ContextAgentReplyResult,
} from "./context-agent.ts";
