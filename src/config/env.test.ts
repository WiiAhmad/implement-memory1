import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../logging/console-logger.ts";
import { ensureRuntimeDirectories, resolveDataPaths } from "../utils/paths.ts";
import { parseEnv } from "./env.ts";

describe("parseEnv", () => {
  test("parses OpenAI chat and embedding settings", () => {
    const env = parseEnv({
      BOT_TOKEN: "123456:telegram-token",
      MEMORY_AGENT: "data",
      PROVIDER: "openai",
      OPENAI_API_KEY: "sk-chat",
      BASE_URL: "https://api.openai.com/v1",
      MODEL: "gpt-4o-mini",
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "sk-embed",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_DIMENSIONS: "1536",
    });

    expect(env.botToken).toBe("123456:telegram-token");
    expect(env.memoryRoot).toBe("data");
    expect(env.provider).toBe("openai");
    expect(env.openAIApiKey).toBe("sk-chat");
    expect(env.baseUrl).toBe("https://api.openai.com/v1");
    expect(env.model).toBe("gpt-4o-mini");
    expect(env.embedding).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embed",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
  });
});

describe("resolveDataPaths", () => {
  test("returns the expected auth, logs, and memory paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-paths-"));

    try {
      const paths = resolveDataPaths(root);

      expect(paths.root).toBe(path.resolve(root));
      expect(paths.authDir).toBe(path.join(path.resolve(root), "auth"));
      expect(paths.logsDir).toBe(path.join(path.resolve(root), "logs"));
      expect(paths.memoryDir).toBe(path.join(path.resolve(root), "memory-tdai"));
      expect(paths.pendingCodesFile).toBe(path.join(paths.authDir, "pending-codes.json"));
      expect(paths.verifiedUsersFile).toBe(path.join(paths.authDir, "verified-users.json"));
      expect(paths.verificationLogFile).toBe(path.join(paths.logsDir, "verification.log"));

      await ensureRuntimeDirectories(paths);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("anchors relative roots to the project instead of the launch cwd", async () => {
    const originalCwd = process.cwd();
    const tempCwd = await mkdtemp(path.join(os.tmpdir(), "agent-cwd-"));

    try {
      process.chdir(tempCwd);

      const paths = resolveDataPaths("data");
      const expectedRoot = path.resolve(import.meta.dir, "..", "..");

      expect(paths.root).toBe(path.join(expectedRoot, "data"));
    } finally {
      process.chdir(originalCwd);
      await rm(tempCwd, { recursive: true, force: true });
    }
  });
});

describe("createLogger", () => {
  test("returns the TencentDB logger shape", () => {
    const logger = createLogger();

    expect(logger).toEqual({
      debug: expect.any(Function),
      info: expect.any(Function),
      warn: expect.any(Function),
      error: expect.any(Function),
    });
  });
});
