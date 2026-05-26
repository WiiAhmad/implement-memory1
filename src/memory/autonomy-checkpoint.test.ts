import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAutonomyCheckpoint, type MemoryCheckpointState } from "./autonomy-checkpoint.ts";

let tmpDir: string;
let checkpoint: MemoryAutonomyCheckpoint;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "autonomy-checkpoint-"));
  checkpoint = new MemoryAutonomyCheckpoint(tmpDir);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("MemoryAutonomyCheckpoint", () => {
  test("returns default state for unknown session", async () => {
    const state = await checkpoint.getState("tg:user:unknown");
    expect(state.lastMemorySeqExtracted).toBe(0);
    expect(state.lastMemorySeqProcessedByL2).toBe(0);
    expect(state.lastL1CompletedAt).toBeNull();
    expect(state.lastL2CompletedAt).toBeNull();
    expect(state.l2JobStatus).toBe("idle");
    expect(state.personaJobStatus).toBe("idle");
    expect(state.sessionIsCold).toBe(false);
  });

  test("round-trips state through get/update", async () => {
    const sessionKey = "tg:user:test1";
    await checkpoint.updateState(sessionKey, {
      lastMemorySeqExtracted: 10,
      lastMemorySeqProcessedByL2: 7,
      lastL1CompletedAt: "2026-05-26T10:00:00.000Z",
      l2JobStatus: "running",
    });

    const state = await checkpoint.getState(sessionKey);
    expect(state.lastMemorySeqExtracted).toBe(10);
    expect(state.lastMemorySeqProcessedByL2).toBe(7);
    expect(state.lastL1CompletedAt).toBe("2026-05-26T10:00:00.000Z");
    expect(state.l2JobStatus).toBe("running");

    // Unchanged fields keep defaults
    expect(state.lastL2CompletedAt).toBeNull();
    expect(state.sessionIsCold).toBe(false);
  });

  test("coexists with existing pipeline state", async () => {
    const sessionKey = "tg:user:test2";
    // Simulate existing pipeline write by writing directly to the checkpoint file
    const metadataDir = path.join(tmpDir, ".metadata");
    await mkdir(metadataDir, { recursive: true });
    const checkpointPath = path.join(metadataDir, "recall_checkpoint.json");
    await writeFile(
      checkpointPath,
      JSON.stringify({
        last_captured_timestamp: 0,
        total_processed: 0,
        last_persona_at: 0,
        last_persona_time: "",
        request_persona_update: false,
        persona_update_reason: "",
        memories_since_last_persona: 0,
        scenes_processed: 0,
        runner_states: {},
        pipeline_states: {
          [sessionKey]: {
            conversation_count: 10,
            l2_pending_l1_count: 3,
            last_extraction_time: 1700000000000,
            last_extraction_updated_time: "",
            l2_last_extraction_time: 1700000000000,
            last_active_time: 1700005000000,
            warmup_threshold: 10,
          },
        },
        l0_conversations_count: 0,
        total_memories_extracted: 0,
      }),
      "utf8",
    );

    // Write autonomy state alongside it
    const cp = new MemoryAutonomyCheckpoint(tmpDir);
    await cp.updateState(sessionKey, {
      lastMemorySeqExtracted: 8,
      l2JobStatus: "idle",
    });

    // Verify pipeline state is intact
    const raw = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(raw.pipeline_states[sessionKey].conversation_count).toBe(10);
    expect(raw.memory_autonomy_state[sessionKey].lastMemorySeqExtracted).toBe(8);
  });

  test("migrates from existing PipelineSessionState when autonomy key missing", async () => {
    const sessionKey = "tg:user:migrate";
    const metadataDir = path.join(tmpDir, ".metadata");
    await mkdir(metadataDir, { recursive: true });
    const checkpointPath = path.join(metadataDir, "recall_checkpoint.json");

    // Fresh checkpoint instance for isolated test
    const migrateDir = await mkdtemp(path.join(os.tmpdir(), "autonomy-migrate-"));
    try {
      const metadataDir2 = path.join(migrateDir, ".metadata");
      await mkdir(metadataDir2, { recursive: true });
      const cpPath = path.join(metadataDir2, "recall_checkpoint.json");

      // Write only pipeline state, no autonomy state
      await writeFile(
        cpPath,
        JSON.stringify({
          pipeline_states: {
            [sessionKey]: {
              conversation_count: 15,
              l2_pending_l1_count: 3,
              last_extraction_time: 1700000000000,
              last_extraction_updated_time: "",
              l2_last_extraction_time: 1699990000000,
              last_active_time: 1700005000000,
              warmup_threshold: 10,
            },
          },
        }),
        "utf8",
      );

      const migrateCp = new MemoryAutonomyCheckpoint(migrateDir);

      // First read triggers migration
      const state = await migrateCp.getState(sessionKey);
      // l2_pending_l1_count=3 means 3 pending → set extracted=3, processed=0 → delta=3
      expect(state.lastMemorySeqExtracted).toBe(3);
      expect(state.lastMemorySeqProcessedByL2).toBe(0);
      // Timestamps converted from epoch ms
      expect(state.lastL1CompletedAt).toBe(new Date(1700000000000).toISOString());
      expect(state.lastL2CompletedAt).toBe(new Date(1699990000000).toISOString());
      expect(state.sessionLastActiveAt).toBe(new Date(1700005000000).toISOString());

      // Verify migration is idempotent (second read doesn't re-migrate)
      const state2 = await migrateCp.getState(sessionKey);
      expect(state2.lastMemorySeqExtracted).toBe(3);
    } finally {
      await rm(migrateDir, { recursive: true, force: true });
    }
  });

  test("updateStates handles multiple sessions atomically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autonomy-batch-"));
    try {
      const cp = new MemoryAutonomyCheckpoint(dir);
      await cp.updateStates({
        "tg:user:alpha": { lastMemorySeqExtracted: 5, l2JobStatus: "scheduled" },
        "tg:user:beta": { lastMemorySeqExtracted: 3, personaJobStatus: "running" },
      });

      const alpha = await cp.getState("tg:user:alpha");
      expect(alpha.lastMemorySeqExtracted).toBe(5);
      expect(alpha.l2JobStatus).toBe("scheduled");

      const beta = await cp.getState("tg:user:beta");
      expect(beta.lastMemorySeqExtracted).toBe(3);
      expect(beta.personaJobStatus).toBe("running");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("getAllStates returns all sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autonomy-all-"));
    try {
      const cp = new MemoryAutonomyCheckpoint(dir);
      await cp.updateState("tg:user:a", { lastMemorySeqExtracted: 1 });
      await cp.updateState("tg:user:b", { lastMemorySeqExtracted: 2 });

      const all = await cp.getAllStates();
      expect(Object.keys(all).sort()).toEqual(["tg:user:a", "tg:user:b"]);
      expect(all["tg:user:a"].lastMemorySeqExtracted).toBe(1);
      expect(all["tg:user:b"].lastMemorySeqExtracted).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("custom namespace is used instead of default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autonomy-ns-"));
    try {
      const cp = new MemoryAutonomyCheckpoint(dir, "my_custom_ns", true);
      await cp.updateState("tg:user:test", { lastMemorySeqExtracted: 42 });

      const metadataDir = path.join(dir, ".metadata");
      const checkpointPath = path.join(metadataDir, "recall_checkpoint.json");
      const raw = JSON.parse(await readFile(checkpointPath, "utf8"));
      expect(raw.my_custom_ns).toBeDefined();
      expect(raw.my_custom_ns["tg:user:test"].lastMemorySeqExtracted).toBe(42);
      // Default namespace should NOT be present
      expect(raw.memory_autonomy_state).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
