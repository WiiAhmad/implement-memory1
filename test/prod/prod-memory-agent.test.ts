import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextAgent } from "../../src/agent/context-agent.ts";
import { parseEnv, type AppEnv } from "../../src/config/env.ts";
import { buildTdaiRawConfig } from "../../src/memory/build-memory-config.ts";
import type { MemoryAdapter } from "../../src/memory/types.ts";
import type { ChatClient, ChatReplyParams } from "../../src/openai/chat-client.ts";
import { parseConfig } from "../../TencentDB-Agent-Memory/src/config.ts";
import { PersonaGenerator } from "../../TencentDB-Agent-Memory/src/core/persona/persona-generator.ts";
import { PersonaTrigger } from "../../TencentDB-Agent-Memory/src/core/persona/persona-trigger.ts";
import { SceneExtractor } from "../../TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts";
import { readSceneIndex } from "../../TencentDB-Agent-Memory/src/core/scene/scene-index.ts";
import type { LLMRunParams, LLMRunner } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import { CheckpointManager } from "../../TencentDB-Agent-Memory/src/utils/checkpoint.ts";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const mockConversationPrompt = [
  "User: I need prod-style testing for the Telegram 1:1 agent.",
  "User: Use my .env model settings and validate memory, scene, persona, and recall.",
  "Assistant: I will keep the test deterministic while preserving the production context path.",
].join("\n");

const generatedSceneContext = [
  "-----META-START-----",
  "created: 2026-05-24T00:00:00.000Z",
  "updated: 2026-05-24T00:00:00.000Z",
  "summary: Production testing preferences for the Telegram 1:1 memory agent",
  "heat: 7",
  "-----META-END-----",
  "",
  "## User Preferences",
  "- The user wants production-shaped tests that read model settings from .env.",
  "- The user wants the 1:1 agent path to validate memory, scene extraction, persona generation, and recall context.",
  "",
  "## Core Narrative",
  "The user asked for a production testing path for a Telegram 1:1 agent. The request moved from broad coverage to a stricter requirement: model configuration must come from .env, while the test can still use deterministic mock LLM behavior. The resulting context should prove that memory scenes and generated persona data reach the final agent prompt.",
].join("\n");

const generatedPersonaContext = [
  "# User Narrative Profile",
  "",
  "> **Archetype (core archetype)**: Production-minded agent builder who wants deterministic validation without drifting from real runtime config.",
  "",
  "> **Long-term Preferences**",
  " - Use .env as the source of model and provider settings.",
  " - Test the full memory path: scene, persona, recall, and 1:1 response context.",
  "",
  "## Chapter 1: Context & Current State",
  "The user is validating a Telegram 1:1 agent and cares about production behavior rather than isolated toy tests.",
  "",
  "## Chapter 3: Interaction & Cognitive Protocol",
  "Keep answers direct, implementation-focused, and grounded in the existing repo behavior.",
].join("\n");

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("production memory agent path", () => {
  test("loads production .env and maps memory/persona/scene settings into TDAI config", async () => {
    const dataRoot = await makeTempRoot();
    const env = parseEnv({
      ...(await readDotEnv()),
      MEMORY_AGENT: dataRoot,
      MEMORY_PERSONA_TRIGGER_N: "2",
      MEMORY_PERSONA_MAX_SCENES: "4",
      MEMORY_PIPELINE_EVERY_N: "1",
      MEMORY_L2_DELAY_AFTER_L1: "0",
      MEMORY_L2_MIN_INTERVAL: "1",
      MEMORY_L2_MAX_INTERVAL: "1",
      MEMORY_RECALL_STRATEGY: "keyword",
      MEMORY_EMBEDDING_ENABLED: "false",
      MEMORY_EMBEDDING_PROVIDER: "none",
    });

    const cfg = parseConfig(buildTdaiRawConfig(env));

    expect(env.memoryRoot).toBe(dataRoot);
    expect(cfg.storeBackend).toBe("sqlite");
    expect(cfg.persona.triggerEveryN).toBe(2);
    expect(cfg.persona.maxScenes).toBe(4);
    expect(cfg.pipeline.everyNConversations).toBe(1);
    expect(cfg.pipeline.l2DelayAfterL1Seconds).toBe(0);
    expect(cfg.recall.strategy).toBe("keyword");
    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.provider).toBe("none");
  });

  test("runs scene extraction, all persona trigger paths, persona generation, and recall injection", async () => {
    const dataDir = await makeTempRoot();
    const env = parseEnv({
      ...(await readDotEnv()),
      MEMORY_AGENT: dataDir,
      MEMORY_PERSONA_TRIGGER_N: "2",
      MEMORY_PERSONA_MAX_SCENES: "4",
      MEMORY_PERSONA_BACKUP_COUNT: "1",
      MEMORY_PERSONA_SCENE_BACKUP: "1",
      MEMORY_PIPELINE_EVERY_N: "1",
      MEMORY_L2_DELAY_AFTER_L1: "0",
      MEMORY_L2_MIN_INTERVAL: "1",
      MEMORY_L2_MAX_INTERVAL: "1",
      MEMORY_RECALL_STRATEGY: "keyword",
      MEMORY_EMBEDDING_ENABLED: "false",
      MEMORY_EMBEDDING_PROVIDER: "none",
    });
    const cfg = parseConfig(buildTdaiRawConfig(env));
    const sceneRunner = new ScriptedRunner(async ({ systemPrompt, prompt, workspaceDir }) => {
      if (!workspaceDir) throw new Error("Scene extraction must receive a sandbox workspace");
      expect(systemPrompt).toContain("Memory Consolidation Architect");
      expect(prompt).toContain("I need prod-style testing for the Telegram 1:1 agent");
      expect(prompt).toContain("validate memory, scene, persona, and recall");
      await fs.writeFile(
        path.join(workspaceDir, "preference-and-workflow.md"),
        generatedSceneContext,
        "utf-8",
      );
      return "[PERSONA_UPDATE_REQUEST]reason: new durable preference[/PERSONA_UPDATE_REQUEST]";
    });

    const extractor = new SceneExtractor({
      dataDir,
      config: {},
      maxScenes: cfg.persona.maxScenes,
      sceneBackupCount: cfg.persona.sceneBackupCount,
      logger,
      llmRunner: sceneRunner,
    });

    const extraction = await extractor.extract([
      {
        id: "mem-1",
        content: mockConversationPrompt,
        created_at: "2026-05-24T00:00:00.000Z",
      },
      {
        id: "mem-2",
        content: "The generated context must reach the final agent prompt for a 1:1 user.",
        created_at: "2026-05-24T00:01:00.000Z",
      },
    ]);

    expect(extraction).toEqual({ memoriesProcessed: 2, success: true });
    expect(sceneRunner.calls).toHaveLength(1);
    expect(sceneRunner.calls[0]!.workspaceDir).toBe(path.join(dataDir, "scene_blocks"));
    expect(await readSceneIndex(dataDir)).toMatchObject([
      {
        filename: "preference-and-workflow.md",
        summary: "Production testing preferences for the Telegram 1:1 memory agent",
        heat: 7,
      },
    ]);
    const sceneContext = await fs.readFile(
      path.join(dataDir, "scene_blocks", "preference-and-workflow.md"),
      "utf-8",
    );
    console.log("\n[manual-prod-test] generated scene context\n", sceneContext);

    const checkpoint = new CheckpointManager(dataDir, logger);
    let cp = await checkpoint.read();
    expect(cp.request_persona_update).toBe(true);
    expect(cp.persona_update_reason).toBe("new durable preference");

    await checkpoint.write({
      ...cp,
      request_persona_update: false,
      persona_update_reason: "",
      scenes_processed: 1,
      memories_since_last_persona: 1,
    });
    await expectTrigger(dataDir, 50, "Cold start");

    cp = await checkpoint.read();
    await checkpoint.write({
      ...cp,
      last_persona_at: 1,
      last_persona_time: "2026-05-23T00:00:00.000Z",
    });
    await fs.writeFile(path.join(dataDir, "persona.md"), "Existing persona body", "utf-8");
    await expectTrigger(dataDir, 50, "First Scene Block extraction completed");

    cp = await checkpoint.read();
    await checkpoint.write({
      ...cp,
      scenes_processed: 2,
      memories_since_last_persona: env.memory.personaTriggerEveryN,
    });
    await expectTrigger(dataDir, env.memory.personaTriggerEveryN, "Threshold reached");

    cp = await checkpoint.read();
    await checkpoint.write({
      ...cp,
      last_persona_at: 10,
      last_persona_time: "2026-05-23T00:00:00.000Z",
      memories_since_last_persona: 0,
    });
    await fs.writeFile(path.join(dataDir, "persona.md"), "\n", "utf-8");
    await expectTrigger(dataDir, env.memory.personaTriggerEveryN, "Recovery");

    const personaRunner = new ScriptedRunner(async ({ systemPrompt, prompt, workspaceDir }) => {
      expect(workspaceDir).toBe(dataDir);
      expect(systemPrompt).toContain("Persona Architect");
      expect(prompt).toContain(generatedSceneContext);
      await fs.writeFile(
        path.join(dataDir, "persona.md"),
        generatedPersonaContext,
        "utf-8",
      );
      return "persona written";
    });
    const generator = new PersonaGenerator({
      dataDir,
      config: {},
      backupCount: cfg.persona.backupCount,
      logger,
      llmRunner: personaRunner,
    });

    await expect(generator.generate("prod test")).resolves.toBe(true);
    const persona = await fs.readFile(path.join(dataDir, "persona.md"), "utf-8");
    expect(persona).toContain("Production-minded agent builder");
    expect(persona).toContain("Scene Navigation");
    console.log("\n[manual-prod-test] generated persona context\n", persona);

    const recallMemory: MemoryAdapter = {
      recall: async () => ({
        prependContext: [
          "<relevant-memories>",
          "- The user wants prod-style memory tests using .env model settings.",
          "- Generated scene and persona context must reach the final 1:1 agent prompt.",
          "</relevant-memories>",
        ].join("\n"),
        appendSystemContext: persona,
      }),
      capture: async () => {},
      close: async () => {},
    };
    let replyParams: ChatReplyParams | undefined;
    const chatClient: ChatClient = {
      reply: async (params) => {
        replyParams = params;
        return "Production memory path is wired.";
      },
    };

    const agent = new ContextAgent({ memory: recallMemory, chatClient, logger });
    const result = await agent.reply({
      telegramUserId: 456,
      userKey: "tg:user:456",
      text: "Check my persona memory.",
      history: [],
    });

    expect(result).toEqual({ reply: "Production memory path is wired.", updateHistory: true });
    expect(replyParams?.userPrompt).toContain("prod-style memory tests using .env model settings");
    expect(replyParams?.userPrompt).toContain("Check my persona memory.");
    expect(replyParams?.systemPrompt).toContain("Production-minded agent builder");
    expect(replyParams?.systemPrompt).toContain("Scene Navigation");
    console.log("\n[manual-prod-test] final 1:1 agent result\n", {
      result,
      userPrompt: replyParams?.userPrompt,
      systemPrompt: replyParams?.systemPrompt,
    });
  });
});

class ScriptedRunner implements LLMRunner {
  readonly calls: LLMRunParams[] = [];

  constructor(private readonly handler: (params: LLMRunParams) => Promise<string>) {}

  async run(params: LLMRunParams): Promise<string> {
    this.calls.push(params);
    return this.handler(params);
  }
}

async function expectTrigger(dataDir: string, interval: number, reasonPrefix: string): Promise<void> {
  const trigger = new PersonaTrigger({ dataDir, interval, logger });
  const result = await trigger.shouldGenerate();
  expect(result.should).toBe(true);
  expect(result.reason).toStartWith(reasonPrefix);
}

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prod-test-"));
  tempRoots.push(dir);
  return dir;
}

async function readDotEnv(): Promise<Record<string, string>> {
  const raw = await fs.readFile(path.resolve(".env"), "utf-8");
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
