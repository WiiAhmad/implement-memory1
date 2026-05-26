// ═══════════════════════════════════════════════════════════════════════
//  [Step 31]  TOOLS MODULE — Re-exports
//  ═══════════════════════════════════════════════════════════════════════
//  Barrel file that re-exports ToolHandler, MEMORY_TOOLS definitions,
//  and the ToolDefinition / ToolExecutor types.
//  Imported by src/main.ts to wire memory search tools into the LLM
//  tool loop, and by src/openai/chat-client.ts for type references.
// ═══════════════════════════════════════════════════════════════════════

export { ToolHandler, MEMORY_TOOLS } from "./tool-handler.ts";
export type { ToolDefinition, ToolExecutor } from "./tool-handler.ts";
