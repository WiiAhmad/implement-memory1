import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env.ts";
import { buildMemorySessionKey, buildTdaiRawConfig } from "./build-memory-config.ts";

const env: AppEnv = {
  botToken: "123456:telegram-token",
  memoryRoot: "data",
  provider: "openai",
  openAIApiKey: "sk-chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  embedding: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-embed",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
};

describe("buildTdaiRawConfig", () => {
  test("maps OpenAI embedding env into the TencentDB schema shape", () => {
    const raw = buildTdaiRawConfig(env);

    expect(raw.storeBackend).toBe("sqlite");
    expect(raw.recall).toEqual({
      enabled: true,
      maxResults: 5,
      strategy: "hybrid",
      timeoutMs: 5000,
    });
    expect(raw.embedding).toEqual({
      enabled: true,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embed",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
  });

  test("builds the stable Telegram memory session key", () => {
    expect(buildMemorySessionKey(42)).toBe("tg:user:42");
  });
});
