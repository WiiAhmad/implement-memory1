/**
 * State-manager wrapper for the offload module.
 *
 * Re-exports the library's OffloadStateManager and SessionRegistry classes
 * which handle per-session state management, tool pair buffering, MMD tracking,
 * and LRU-cached session routing.
 *
 * The OffloadStateManager's public API includes:
 *   - init(dataRoot, agentName, sessionId)  — initialize for a session
 *   - switchSession(sessionKey, dataRoot)   — switch to a different session
 *   - save()                                — persist state to disk
 *   - addToolPair(pair)                     — buffer a tool call/result pair
 *   - takePending(max)                      — consume buffered pairs for L1
 *   - getPendingCount() / hasPending()      — check buffer status
 *   - setActiveMmd(file, id)               — track current MMD
 *   - getActiveMmdFile() / getActiveMmdId() — get current MMD
 *
 * The SessionRegistry provides:
 *   - resolve(sessionKey)                   — get/create per-session manager
 *   - get(sessionKey)                       — look up existing session
 *   - LRU eviction (max 20 cached sessions)
 */

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
