// ═══════════════════════════════════════════════════════════════════════
//  [Step 17]  MEMORY TYPES — Adapter Interface for TDAI Memory Engine
//  ═══════════════════════════════════════════════════════════════════════
//  Defines the MemoryAdapter interface that bridges the Telegram bot
//  with the TencentDB-Agent-Memory engine (TDAI).
//  All concrete memory implementations must implement recall + capture + close.
// ═══════════════════════════════════════════════════════════════════════

// ─── Step 17a: Recall result ──────────────────────────────────────────
//  Returned before each LLM turn with relevant memories from past conversations.
export interface MemoryRecall {
  prependContext?: string;       // Relevant memories prepended to the user message
  appendSystemContext?: string;  // Stable system context (persona, scene nav, tools)
}

// ─── Step 17b: MemoryAdapter interface ────────────────────────────────
//  The contract that any memory backend must satisfy.
//  - recall: called BEFORE LLM reply — retrieves relevant memories
//  - capture: called AFTER LLM reply — stores the conversation turn
//  - close: called on shutdown — releases engine resources
export interface MemoryAdapter {
  recall(userKey: string, query: string): Promise<MemoryRecall>;
  capture(userKey: string, userText: string, assistantText: string): Promise<void>;
  close(): Promise<void>;
}
