import { z } from "zod";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  MEMORY_AGENT: z.string().min(1).default("data"),
  PROVIDER: z.literal("openai"),
  OPENAI_API_KEY: z.string().min(1),
  BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  MODEL: z.string().min(1),
  EMBEDDING_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive(),
});

export interface AppEnv {
  botToken: string;
  memoryRoot: string;
  provider: "openai";
  openAIApiKey: string;
  baseUrl: string;
  model: string;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
}

export function parseEnv(input: Record<string, string | undefined>): AppEnv {
  const parsed = EnvSchema.parse(input);

  return {
    botToken: parsed.BOT_TOKEN,
    memoryRoot: parsed.MEMORY_AGENT,
    provider: parsed.PROVIDER,
    openAIApiKey: parsed.OPENAI_API_KEY,
    baseUrl: parsed.BASE_URL,
    model: parsed.MODEL,
    embedding: {
      baseUrl: parsed.EMBEDDING_BASE_URL,
      apiKey: parsed.EMBEDDING_API_KEY,
      model: parsed.EMBEDDING_MODEL,
      dimensions: parsed.EMBEDDING_DIMENSIONS,
    },
  };
}
