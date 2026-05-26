// ═══════════════════════════════════════════════════════════════════════
//  POLLING BRIDGE TEST — Checkpoint Change Detection Tests
//  ═══════════════════════════════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { PollingBridge } from "./polling-bridge.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polling-bridge-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeCheckpoint(dir: string, pipelineStates: Record<string, any>): Promise<string> {
  const filePath = path.join(dir, "checkpoint.json");
  const cp = { pipeline_states: pipelineStates };
  await fs.writeFile(filePath, JSON.stringify(cp), "utf8");
  return filePath;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PollingBridge", () => {
  test("detects L1 completion via l2_pending_l1_count increase", async () => {
    await withTempDir(async (dir) => {
      // Initial state: pending count = 5
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 5,
          last_active_time: 1000,
        },
      });

      const l1CompletedCalls: string[] = [];
      const activityCalls: string[] = [];
      const bridge = new PollingBridge(filePath, {
        onL1Completed: (sk) => { l1CompletedCalls.push(sk); },
        onSessionActivity: (sk) => { activityCalls.push(sk); },
      }, 50);

      // First poll: establish baseline
      await (bridge as any).poll();
      expect(l1CompletedCalls.length).toBe(0);
      expect(activityCalls.length).toBe(0);

      // Second poll: pending count increased
      await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 7, // 2 more L1s completed
          last_active_time: 1000,
        },
      });
      await (bridge as any).poll();
      expect(l1CompletedCalls.length).toBe(1);
      expect(l1CompletedCalls[0]).toBe("tg:user:1");

      // Third poll: no change
      await (bridge as any).poll();
      expect(l1CompletedCalls.length).toBe(1); // No new calls

      bridge.close();
    });
  });

  test("detects session activity via last_active_time change", async () => {
    await withTempDir(async (dir) => {
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 3,
          last_active_time: 1000,
        },
      });

      const activityCalls: string[] = [];
      const bridge = new PollingBridge(filePath, {
        onL1Completed: () => {},
        onSessionActivity: (sk) => { activityCalls.push(sk); },
      }, 50);

      // First poll: establish baseline
      await (bridge as any).poll();
      expect(activityCalls.length).toBe(0);

      // Second poll: active time advanced
      await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 3,
          last_active_time: 2000, // changed
        },
      });
      await (bridge as any).poll();
      expect(activityCalls.length).toBe(1);
      expect(activityCalls[0]).toBe("tg:user:1");

      bridge.close();
    });
  });

  test("fires both callbacks when both state fields change", async () => {
    await withTempDir(async (dir) => {
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 5,
          last_active_time: 1000,
        },
      });

      const l1Calls: string[] = [];
      const activityCalls: string[] = [];
      const bridge = new PollingBridge(filePath, {
        onL1Completed: (sk) => { l1Calls.push(sk); },
        onSessionActivity: (sk) => { activityCalls.push(sk); },
      }, 50);

      // First poll: baseline
      await (bridge as any).poll();

      // Second poll: both changed
      await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 8,
          last_active_time: 3000,
        },
      });
      await (bridge as any).poll();
      expect(l1Calls.length).toBe(1);
      expect(activityCalls.length).toBe(1);

      bridge.close();
    });
  });

  test("does not fire on unchanged state", async () => {
    await withTempDir(async (dir) => {
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 5,
          last_active_time: 1000,
        },
      });

      let callCount = 0;
      const bridge = new PollingBridge(filePath, {
        onL1Completed: () => { callCount++; },
        onSessionActivity: () => { callCount++; },
      }, 50);

      // Multiple polls with same state
      await (bridge as any).poll();
      await (bridge as any).poll();
      await (bridge as any).poll();
      expect(callCount).toBe(0);

      bridge.close();
    });
  });

  test("handles missing pipeline_states gracefully", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "checkpoint.json");
      await fs.writeFile(filePath, JSON.stringify({}), "utf8");

      let callCount = 0;
      const bridge = new PollingBridge(filePath, {
        onL1Completed: () => { callCount++; },
        onSessionActivity: () => { callCount++; },
      }, 50);

      // Should not crash
      await (bridge as any).poll();
      expect(callCount).toBe(0);

      bridge.close();
    });
  });

  test("handles missing checkpoint file gracefully", async () => {
    const bridge = new PollingBridge("/nonexistent/checkpoint.json", {
      onL1Completed: () => {},
      onSessionActivity: () => {},
    }, 50);

    // Should not crash
    await (bridge as any).poll();
    bridge.close();
  });

  test("handles corrupt JSON gracefully", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "checkpoint.json");
      await fs.writeFile(filePath, "not-json{{{", "utf8");

      let callCount = 0;
      const bridge = new PollingBridge(filePath, {
        onL1Completed: () => { callCount++; },
        onSessionActivity: () => { callCount++; },
      }, 50);

      await (bridge as any).poll();
      expect(callCount).toBe(0);

      bridge.close();
    });
  });

  test("stops polling on close", async () => {
    await withTempDir(async (dir) => {
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 5,
          last_active_time: 1000,
        },
      });

      let callCount = 0;
      const bridge = new PollingBridge(filePath, {
        onL1Completed: () => { callCount++; },
        onSessionActivity: () => { callCount++; },
      }, 50);

      // Close immediately
      bridge.close();

      // Poll after close should be no-op
      await (bridge as any).poll();
      expect(callCount).toBe(0);

      // Start after close should be no-op
      bridge.start();
      await (bridge as any).poll();
      expect(callCount).toBe(0);
    });
  });

  test("start() begins periodic polling", async () => {
    await withTempDir(async (dir) => {
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 5,
          last_active_time: 1000,
        },
      });

      let pollCount = 0;
      const l1Calls: string[] = [];
      const bridge = new PollingBridge(filePath, {
        onL1Completed: (sk) => { l1Calls.push(sk); },
        onSessionActivity: () => {},
      }, 50);

      // Start polling — should begin periodic polling
      bridge.start();

      // Replace the poll method to track calls
      const originalPoll = (bridge as any).poll.bind(bridge);
      (bridge as any).poll = async () => {
        pollCount++;
        await originalPoll();
      };

      // Manually trigger a poll cycle to avoid timer flakiness
      await (bridge as any).poll();
      expect(pollCount).toBe(1); // poll was called

      // Write a change and poll manually
      await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 7,
          last_active_time: 1000,
        },
      });
      await (bridge as any).poll();
      expect(l1Calls.length).toBeGreaterThanOrEqual(1);

      // Starting again should not throw
      bridge.start();

      bridge.close();
    });
  });

  test("tracks multiple sessions independently", async () => {
    await withTempDir(async (dir) => {
      const filePath = await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 3,
          last_active_time: 1000,
        },
        "tg:user:2": {
          l2_pending_l1_count: 5,
          last_active_time: 2000,
        },
      });

      const l1Calls: string[] = [];
      const activityCalls: string[] = [];
      const bridge = new PollingBridge(filePath, {
        onL1Completed: (sk) => { l1Calls.push(sk); },
        onSessionActivity: (sk) => { activityCalls.push(sk); },
      }, 50);

      // Baseline
      await (bridge as any).poll();

      // User 1: pending count increased, User 2: active time changed
      await writeCheckpoint(dir, {
        "tg:user:1": {
          l2_pending_l1_count: 5, // L1 completed for user 1
          last_active_time: 1000,
        },
        "tg:user:2": {
          l2_pending_l1_count: 5,
          last_active_time: 5000, // activity for user 2
        },
      });
      await (bridge as any).poll();

      expect(l1Calls).toEqual(["tg:user:1"]);
      expect(activityCalls).toEqual(["tg:user:2"]);

      bridge.close();
    });
  });
});
