// ═══════════════════════════════════════════════════════════════════════
//  [Step 23]  OFFLOAD STATE MANAGER — Session State & Tool Pair Buffering
//  ═══════════════════════════════════════════════════════════════════════
//  Re-exports the library's OffloadStateManager and SessionRegistry classes.
//
//  OffloadStateManager handles:
//    - Per-session state persistence (active MMD, counters, boundaries)
//    - Tool pair buffering (addToolPair / takePending for L1 flush)
//    - MMD lifecycle (setActiveMmd, getActiveMmdFile)
//    - L2 scheduling state (lastL2TriggerTime)
//
//  SessionRegistry provides:
//    - LRU-cached session resolution (max 20 cached sessions)
//    - Automatic eviction of stale sessions
// ═══════════════════════════════════════════════════════════════════════

export {
  OffloadStateManager,
} from "../../TencentDB-Agent-Memory/src/offload/state-manager.ts";

export {
  SessionRegistry,
} from "../../TencentDB-Agent-Memory/src/offload/session-registry.ts";

export type {
  ToolPair,
  PluginState,
  L15Boundary,
} from "../../TencentDB-Agent-Memory/src/offload/types.ts";
