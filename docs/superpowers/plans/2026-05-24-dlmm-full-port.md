# dlmm Full Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the full dlmm daemon behavior from the source repository into the target Bun/TypeScript agent as an isolated, testable `src/dlmm/**` subsystem.

**Architecture:** Implement dlmm as a bounded subsystem with typed config, target-native data paths, JSON repositories under `data/dlmm/**`, complete prompt builders, core trading services, autonomous schedulers, hybrid Telegram ops, a Discord sidecar, PM2/Bun process support, and a gated self-update flow. Keep external systems behind adapters so dry-run mode and tests are deterministic.

**Tech Stack:** Bun, TypeScript ESM, `bun:test`, Zod, grammy, OpenAI-compatible chat APIs, Solana RPC, Meteora DLMM SDK, Helius, Jupiter, PM2.

---

## File structure

### Phase 1 creates or modifies

- Create: `src/dlmm/config/env.ts` — own the `DLMM_*` Zod schema and `parseDlmmEnv()` parser.
- Create: `src/dlmm/config/env.test.ts` — test dlmm config defaults and explicit overrides in isolation.
- Modify: `src/config/env.ts` — compose `parseDlmmEnv()` into `AppEnv` as `env.dlmm` without embedding the dlmm schema.
- Modify: `src/config/env.test.ts` — add only a small app-level assertion that `env.dlmm` is composed.
- Modify: `src/utils/paths.ts` — add `dlmmDir`, `dlmmLogsDir`, and JSON file paths under the configured data root.
- Modify: `.env.example` — document the initial `DLMM_*` environment variables in the single app env example.
- Create: `src/dlmm/config/types.ts` — exported TypeScript config types used by later phases.
- Create: `src/dlmm/state/types.ts` — exported state, position, pool-memory, lesson, strategy, signal, Discord queue, and decision-log types.
- Create: `src/dlmm/state/json-store.ts` — reusable typed JSON load/save helper.
- Create: `src/dlmm/state/repositories.ts` — repository factory for all `data/dlmm/**` JSON files.
- Create: `src/dlmm/state/repositories.test.ts` — JSON repository round-trip and corrupt-file tests.
- Create: `src/dlmm/index.ts` — narrow public exports for config/state types and repository creation.

### Later phases create or modify

- Create: `src/dlmm/prompts/*.ts` and tests — full standalone prompt builders.
- Create: `src/dlmm/core/*.ts` and tests — trading action services, safety checks, dry-run behavior, SDK adapters.
- Create: `src/dlmm/learning/*.ts` and tests — lessons, signal weights, pool memory, strategy library, smart wallets, blacklists.
- Create: `src/dlmm/screening/*.ts` and tests — candidate discovery, filters, scoring, Discord queue intake, deploy orchestration.
- Create: `src/dlmm/management/*.ts` and tests — position monitoring, OOR, claim/close/rebalance decisions.
- Create: `src/dlmm/ops/*.ts` and tests — Telegram command routing, alerts, briefing, self-update.
- Create: `src/dlmm/discord-listener/*.ts` and tests — source-compatible Discord sidecar and signal extraction.
- Create: `src/dlmm/runtime/*.ts` and tests — lifecycle, schedulers, race guards, startup/shutdown.
- Modify: `src/main.ts` — wire dlmm lifecycle behind `env.dlmm.enabled` once runtime exists.
- Modify: `package.json`, `.env.example`, `README.md`, `ecosystem.config.cjs` or `ecosystem.config.ts` — scripts, docs, PM2/Bun supervision.

---

## Phase 1: Scaffold config, paths, and state contracts

### Task 1: Add separated dlmm environment parsing

**Files:**
- Create: `src/dlmm/config/types.ts`
- Create: `src/dlmm/config/env.ts`
- Create: `src/dlmm/config/env.test.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing isolated dlmm env parsing tests**

Create `src/dlmm/config/env.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseDlmmEnv } from "./env.ts";

describe("parseDlmmEnv", () => {
  test("parses dlmm defaults when no DLMM vars are set", () => {
    const env = parseDlmmEnv({}, { defaultModel: "gpt-4o-mini" });

    expect(env.enabled).toBe(false);
    expect(env.dryRun).toBe(true);
    expect(env.walletPrivateKey).toBeUndefined();
    expect(env.rpcUrl).toBeUndefined();
    expect(env.risk.maxPositions).toBe(3);
    expect(env.risk.maxDeployAmountSol).toBe(50);
    expect(env.risk.gasReserveSol).toBe(0.2);
    expect(env.management.deployAmountSol).toBe(0.5);
    expect(env.management.minSolToOpen).toBe(0.55);
    expect(env.management.positionSizePct).toBe(0.35);
    expect(env.screening.minTvl).toBe(10_000);
    expect(env.screening.maxTvl).toBe(150_000);
    expect(env.screening.minVolume).toBe(500);
    expect(env.screening.minOrganic).toBe(60);
    expect(env.screening.minHolders).toBe(500);
    expect(env.screening.minBinStep).toBe(80);
    expect(env.screening.maxBinStep).toBe(125);
    expect(env.strategy.minBinsBelow).toBe(35);
    expect(env.strategy.maxBinsBelow).toBe(69);
    expect(env.schedule.screeningIntervalMin).toBe(30);
    expect(env.schedule.managementIntervalMin).toBe(10);
    expect(env.schedule.healthCheckIntervalMin).toBe(30);
    expect(env.llm.managementModel).toBe("gpt-4o-mini");
    expect(env.integrations.discord.enabled).toBe(false);
    expect(env.selfUpdate.enabled).toBe(false);
  });

  test("parses explicit dlmm env vars", () => {
    const env = parseDlmmEnv({
      DLMM_ENABLED: "true",
      DLMM_DRY_RUN: "false",
      DLMM_WALLET_PRIVATE_KEY: "wallet-secret",
      DLMM_RPC_URL: "https://rpc.example.com",
      DLMM_HELIUS_API_KEY: "helius-key",
      DLMM_MAX_POSITIONS: "5",
      DLMM_MAX_DEPLOY_AMOUNT_SOL: "2.5",
      DLMM_GAS_RESERVE_SOL: "0.3",
      DLMM_DEPLOY_AMOUNT_SOL: "0.75",
      DLMM_MIN_SOL_TO_OPEN: "0.8",
      DLMM_POSITION_SIZE_PCT: "0.4",
      DLMM_MIN_TVL: "20000",
      DLMM_MAX_TVL: "250000",
      DLMM_MIN_VOLUME: "1500",
      DLMM_MIN_ORGANIC: "70",
      DLMM_MIN_HOLDERS: "750",
      DLMM_MIN_BIN_STEP: "90",
      DLMM_MAX_BIN_STEP: "140",
      DLMM_BLOCKED_LAUNCHPADS: "bad-one,bad-two",
      DLMM_ALLOWED_LAUNCHPADS: "good-one,good-two",
      DLMM_MIN_BINS_BELOW: "40",
      DLMM_MAX_BINS_BELOW: "80",
      DLMM_SCREENING_INTERVAL_MIN: "15",
      DLMM_MANAGEMENT_INTERVAL_MIN: "5",
      DLMM_HEALTH_CHECK_INTERVAL_MIN: "20",
      DLMM_MANAGEMENT_MODEL: "manager-model",
      DLMM_SCREENING_MODEL: "screening-model",
      DLMM_GENERAL_MODEL: "general-model",
      DLMM_TELEGRAM_OPERATOR_CHAT_ID: "12345",
      DLMM_DISCORD_ENABLED: "true",
      DLMM_DISCORD_TOKEN: "discord-token",
      DLMM_DISCORD_GUILD_IDS: "guild-a,guild-b",
      DLMM_DISCORD_CHANNEL_IDS: "chan-a,chan-b",
      DLMM_ALLOW_SELF_UPDATE: "true",
      DLMM_SELF_UPDATE_BRANCH: "main",
      DLMM_SELF_UPDATE_RESTART_COMMAND: "pm2 restart dlmm-agent",
    }, { defaultModel: "gpt-4o-mini" });

    expect(env.enabled).toBe(true);
    expect(env.dryRun).toBe(false);
    expect(env.walletPrivateKey).toBe("wallet-secret");
    expect(env.rpcUrl).toBe("https://rpc.example.com");
    expect(env.heliusApiKey).toBe("helius-key");
    expect(env.risk.maxPositions).toBe(5);
    expect(env.risk.maxDeployAmountSol).toBe(2.5);
    expect(env.risk.gasReserveSol).toBe(0.3);
    expect(env.management.deployAmountSol).toBe(0.75);
    expect(env.management.minSolToOpen).toBe(0.8);
    expect(env.management.positionSizePct).toBe(0.4);
    expect(env.screening.minTvl).toBe(20_000);
    expect(env.screening.maxTvl).toBe(250_000);
    expect(env.screening.minVolume).toBe(1_500);
    expect(env.screening.minOrganic).toBe(70);
    expect(env.screening.minHolders).toBe(750);
    expect(env.screening.minBinStep).toBe(90);
    expect(env.screening.maxBinStep).toBe(140);
    expect(env.screening.blockedLaunchpads).toEqual(["bad-one", "bad-two"]);
    expect(env.screening.allowedLaunchpads).toEqual(["good-one", "good-two"]);
    expect(env.strategy.minBinsBelow).toBe(40);
    expect(env.strategy.maxBinsBelow).toBe(80);
    expect(env.schedule.screeningIntervalMin).toBe(15);
    expect(env.schedule.managementIntervalMin).toBe(5);
    expect(env.schedule.healthCheckIntervalMin).toBe(20);
    expect(env.llm.managementModel).toBe("manager-model");
    expect(env.llm.screeningModel).toBe("screening-model");
    expect(env.llm.generalModel).toBe("general-model");
    expect(env.integrations.telegram.operatorChatId).toBe("12345");
    expect(env.integrations.discord.enabled).toBe(true);
    expect(env.integrations.discord.token).toBe("discord-token");
    expect(env.integrations.discord.guildIds).toEqual(["guild-a", "guild-b"]);
    expect(env.integrations.discord.channelIds).toEqual(["chan-a", "chan-b"]);
    expect(env.selfUpdate.enabled).toBe(true);
    expect(env.selfUpdate.branch).toBe("main");
    expect(env.selfUpdate.restartCommand).toBe("pm2 restart dlmm-agent");
  });
});
```

- [ ] **Step 2: Run isolated dlmm env tests and verify they fail**

Run:

```bash
bun test src/dlmm/config/env.test.ts
```

Expected: FAIL because `src/dlmm/config/env.ts` does not exist.

- [ ] **Step 3: Create config type file**

Create `src/dlmm/config/types.ts`:

```ts
export interface DlmmConfig {
  enabled: boolean;
  dryRun: boolean;
  walletPrivateKey?: string;
  rpcUrl?: string;
  heliusApiKey?: string;
  lpAgentApiKey?: string;
  risk: DlmmRiskConfig;
  screening: DlmmScreeningConfig;
  management: DlmmManagementConfig;
  strategy: DlmmStrategyConfig;
  schedule: DlmmScheduleConfig;
  llm: DlmmLlmConfig;
  integrations: DlmmIntegrationsConfig;
  selfUpdate: DlmmSelfUpdateConfig;
}

export interface DlmmRiskConfig {
  maxPositions: number;
  maxDeployAmountSol: number;
  gasReserveSol: number;
}

export interface DlmmScreeningConfig {
  minTvl: number;
  maxTvl: number;
  minVolume: number;
  minOrganic: number;
  minHolders: number;
  minMcap: number;
  maxMcap: number;
  minBinStep: number;
  maxBinStep: number;
  timeframe: string;
  category: string;
  minTokenFeesSol: number;
  maxBundlePct: number;
  maxBotHoldersPct: number;
  maxTop10Pct: number;
  blockedLaunchpads: string[];
  allowedLaunchpads: string[];
  minTokenAgeHours: number;
  maxTokenAgeHours: number;
  athFilterPct: number;
}

export interface DlmmManagementConfig {
  deployAmountSol: number;
  minSolToOpen: number;
  positionSizePct: number;
  minClaimAmountUsd: number;
  autoSwapAfterClaim: boolean;
  outOfRangeBinsToClose: number;
  outOfRangeWaitMinutes: number;
  oorCooldownTriggerCount: number;
  oorCooldownHours: number;
  repeatDeployCooldownEnabled: boolean;
  repeatDeployCooldownTriggerCount: number;
  repeatDeployCooldownHours: number;
  repeatDeployCooldownScope: "pool" | "token" | "both";
  repeatDeployCooldownMinFeeEarnedPct: number;
  minVolumeToRebalance: number;
  stopLossPct: number;
  takeProfitPct: number;
  minFeePerTvl24h: number;
  minAgeBeforeYieldCheckMinutes: number;
  trailingTakeProfit: boolean;
  trailingTriggerPct: number;
  trailingDropPct: number;
}

export interface DlmmStrategyConfig {
  defaultStrategy: string;
  minBinsBelow: number;
  maxBinsBelow: number;
  defaultBinsBelow: number;
}

export interface DlmmScheduleConfig {
  screeningIntervalMin: number;
  managementIntervalMin: number;
  healthCheckIntervalMin: number;
  briefingHourLocal: number;
}

export interface DlmmLlmConfig {
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  managementModel: string;
  screeningModel: string;
  generalModel: string;
}

export interface DlmmIntegrationsConfig {
  telegram: {
    operatorChatId?: string;
    allowedUserIds: string[];
  };
  discord: {
    enabled: boolean;
    token?: string;
    guildIds: string[];
    channelIds: string[];
    authorName: string;
  };
  hiveMind: {
    enabled: boolean;
    url?: string;
    apiKey?: string;
    agentId?: string;
  };
  jupiter: {
    apiKey?: string;
    referralAccount?: string;
    referralFeeBps: number;
  };
}

export interface DlmmSelfUpdateConfig {
  enabled: boolean;
  branch: string;
  restartCommand: string;
}
```

- [ ] **Step 4: Implement env parsing**

In `src/config/env.ts`, import the type:

```ts
import type { DlmmConfig } from "../dlmm/config/types.ts";
```

Add this helper above `EnvSchema`:

```ts
const boolString = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const csvString = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean));
```

Replace repeated boolean schema definitions only when convenient, but do not refactor unrelated parsing. Add these fields to `EnvSchema`:

```ts
  // ── dlmm Full Port Config ───────────────────────────────────────────────
  DLMM_ENABLED: boolString.default("false"),
  DLMM_DRY_RUN: boolString.default("true"),
  DLMM_WALLET_PRIVATE_KEY: z.string().optional(),
  DLMM_RPC_URL: z.string().url().optional(),
  DLMM_HELIUS_API_KEY: z.string().optional(),
  DLMM_LPAGENT_API_KEY: z.string().optional(),

  DLMM_MAX_POSITIONS: z.coerce.number().int().positive().default(3),
  DLMM_MAX_DEPLOY_AMOUNT_SOL: z.coerce.number().positive().default(50),
  DLMM_GAS_RESERVE_SOL: z.coerce.number().min(0).default(0.2),

  DLMM_MIN_TVL: z.coerce.number().min(0).default(10_000),
  DLMM_MAX_TVL: z.coerce.number().min(0).default(150_000),
  DLMM_MIN_VOLUME: z.coerce.number().min(0).default(500),
  DLMM_MIN_ORGANIC: z.coerce.number().min(0).max(100).default(60),
  DLMM_MIN_HOLDERS: z.coerce.number().int().min(0).default(500),
  DLMM_MIN_MCAP: z.coerce.number().min(0).default(150_000),
  DLMM_MAX_MCAP: z.coerce.number().min(0).default(10_000_000),
  DLMM_MIN_BIN_STEP: z.coerce.number().int().positive().default(80),
  DLMM_MAX_BIN_STEP: z.coerce.number().int().positive().default(125),
  DLMM_TIMEFRAME: z.string().default("5m"),
  DLMM_CATEGORY: z.string().default("trending"),
  DLMM_MIN_TOKEN_FEES_SOL: z.coerce.number().min(0).default(30),
  DLMM_MAX_BUNDLE_PCT: z.coerce.number().min(0).max(100).default(30),
  DLMM_MAX_BOT_HOLDERS_PCT: z.coerce.number().min(0).max(100).default(25),
  DLMM_MAX_TOP10_PCT: z.coerce.number().min(0).max(100).default(60),
  DLMM_BLOCKED_LAUNCHPADS: csvString,
  DLMM_ALLOWED_LAUNCHPADS: csvString,
  DLMM_MIN_TOKEN_AGE_HOURS: z.coerce.number().min(0).default(0),
  DLMM_MAX_TOKEN_AGE_HOURS: z.coerce.number().min(0).default(720),
  DLMM_ATH_FILTER_PCT: z.coerce.number().min(0).max(100).default(80),

  DLMM_DEPLOY_AMOUNT_SOL: z.coerce.number().positive().default(0.5),
  DLMM_MIN_SOL_TO_OPEN: z.coerce.number().positive().default(0.55),
  DLMM_POSITION_SIZE_PCT: z.coerce.number().min(0).max(1).default(0.35),
  DLMM_MIN_CLAIM_AMOUNT_USD: z.coerce.number().min(0).default(5),
  DLMM_AUTO_SWAP_AFTER_CLAIM: boolString.default("false"),
  DLMM_OUT_OF_RANGE_BINS_TO_CLOSE: z.coerce.number().int().min(0).default(0),
  DLMM_OUT_OF_RANGE_WAIT_MINUTES: z.coerce.number().int().min(0).default(30),
  DLMM_OOR_COOLDOWN_TRIGGER_COUNT: z.coerce.number().int().positive().default(2),
  DLMM_OOR_COOLDOWN_HOURS: z.coerce.number().min(0).default(24),
  DLMM_REPEAT_DEPLOY_COOLDOWN_ENABLED: boolString.default("true"),
  DLMM_REPEAT_DEPLOY_COOLDOWN_TRIGGER_COUNT: z.coerce.number().int().positive().default(2),
  DLMM_REPEAT_DEPLOY_COOLDOWN_HOURS: z.coerce.number().min(0).default(24),
  DLMM_REPEAT_DEPLOY_COOLDOWN_SCOPE: z.enum(["pool", "token", "both"]).default("both"),
  DLMM_REPEAT_DEPLOY_COOLDOWN_MIN_FEE_EARNED_PCT: z.coerce.number().min(0).default(0),
  DLMM_MIN_VOLUME_TO_REBALANCE: z.coerce.number().min(0).default(0),
  DLMM_STOP_LOSS_PCT: z.coerce.number().min(0).default(20),
  DLMM_TAKE_PROFIT_PCT: z.coerce.number().min(0).default(10),
  DLMM_MIN_FEE_PER_TVL_24H: z.coerce.number().min(0).default(0),
  DLMM_MIN_AGE_BEFORE_YIELD_CHECK_MINUTES: z.coerce.number().int().min(0).default(30),
  DLMM_TRAILING_TAKE_PROFIT: boolString.default("false"),
  DLMM_TRAILING_TRIGGER_PCT: z.coerce.number().min(0).default(12),
  DLMM_TRAILING_DROP_PCT: z.coerce.number().min(0).default(4),

  DLMM_DEFAULT_STRATEGY: z.string().default("custom_ratio_spot"),
  DLMM_MIN_BINS_BELOW: z.coerce.number().int().positive().default(35),
  DLMM_MAX_BINS_BELOW: z.coerce.number().int().positive().default(69),
  DLMM_DEFAULT_BINS_BELOW: z.coerce.number().int().positive().default(35),

  DLMM_SCREENING_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  DLMM_MANAGEMENT_INTERVAL_MIN: z.coerce.number().int().positive().default(10),
  DLMM_HEALTH_CHECK_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  DLMM_BRIEFING_HOUR_LOCAL: z.coerce.number().int().min(0).max(23).default(8),

  DLMM_LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  DLMM_LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  DLMM_LLM_MAX_STEPS: z.coerce.number().int().positive().default(8),
  DLMM_MANAGEMENT_MODEL: z.string().optional(),
  DLMM_SCREENING_MODEL: z.string().optional(),
  DLMM_GENERAL_MODEL: z.string().optional(),

  DLMM_TELEGRAM_OPERATOR_CHAT_ID: z.string().optional(),
  DLMM_TELEGRAM_ALLOWED_USER_IDS: csvString,
  DLMM_DISCORD_ENABLED: boolString.default("false"),
  DLMM_DISCORD_TOKEN: z.string().optional(),
  DLMM_DISCORD_GUILD_IDS: csvString,
  DLMM_DISCORD_CHANNEL_IDS: csvString,
  DLMM_DISCORD_AUTHOR_NAME: z.string().default("Metlex Pool Bot"),
  DLMM_HIVEMIND_ENABLED: boolString.default("false"),
  DLMM_HIVEMIND_URL: z.string().url().optional(),
  DLMM_HIVEMIND_API_KEY: z.string().optional(),
  DLMM_HIVEMIND_AGENT_ID: z.string().optional(),
  DLMM_JUPITER_API_KEY: z.string().optional(),
  DLMM_JUPITER_REFERRAL_ACCOUNT: z.string().optional(),
  DLMM_JUPITER_REFERRAL_FEE_BPS: z.coerce.number().int().min(0).default(0),

  DLMM_ALLOW_SELF_UPDATE: boolString.default("false"),
  DLMM_SELF_UPDATE_BRANCH: z.string().default("main"),
  DLMM_SELF_UPDATE_RESTART_COMMAND: z.string().default("pm2 restart dlmm-agent"),
```

Add `dlmm: DlmmConfig;` to `AppEnv`.

Add this object to the return value of `parseEnv()`:

```ts
    dlmm: {
      enabled: parsed.DLMM_ENABLED,
      dryRun: parsed.DLMM_DRY_RUN,
      walletPrivateKey: parsed.DLMM_WALLET_PRIVATE_KEY,
      rpcUrl: parsed.DLMM_RPC_URL,
      heliusApiKey: parsed.DLMM_HELIUS_API_KEY,
      lpAgentApiKey: parsed.DLMM_LPAGENT_API_KEY,
      risk: {
        maxPositions: parsed.DLMM_MAX_POSITIONS,
        maxDeployAmountSol: parsed.DLMM_MAX_DEPLOY_AMOUNT_SOL,
        gasReserveSol: parsed.DLMM_GAS_RESERVE_SOL,
      },
      screening: {
        minTvl: parsed.DLMM_MIN_TVL,
        maxTvl: parsed.DLMM_MAX_TVL,
        minVolume: parsed.DLMM_MIN_VOLUME,
        minOrganic: parsed.DLMM_MIN_ORGANIC,
        minHolders: parsed.DLMM_MIN_HOLDERS,
        minMcap: parsed.DLMM_MIN_MCAP,
        maxMcap: parsed.DLMM_MAX_MCAP,
        minBinStep: parsed.DLMM_MIN_BIN_STEP,
        maxBinStep: parsed.DLMM_MAX_BIN_STEP,
        timeframe: parsed.DLMM_TIMEFRAME,
        category: parsed.DLMM_CATEGORY,
        minTokenFeesSol: parsed.DLMM_MIN_TOKEN_FEES_SOL,
        maxBundlePct: parsed.DLMM_MAX_BUNDLE_PCT,
        maxBotHoldersPct: parsed.DLMM_MAX_BOT_HOLDERS_PCT,
        maxTop10Pct: parsed.DLMM_MAX_TOP10_PCT,
        blockedLaunchpads: parsed.DLMM_BLOCKED_LAUNCHPADS,
        allowedLaunchpads: parsed.DLMM_ALLOWED_LAUNCHPADS,
        minTokenAgeHours: parsed.DLMM_MIN_TOKEN_AGE_HOURS,
        maxTokenAgeHours: parsed.DLMM_MAX_TOKEN_AGE_HOURS,
        athFilterPct: parsed.DLMM_ATH_FILTER_PCT,
      },
      management: {
        deployAmountSol: parsed.DLMM_DEPLOY_AMOUNT_SOL,
        minSolToOpen: parsed.DLMM_MIN_SOL_TO_OPEN,
        positionSizePct: parsed.DLMM_POSITION_SIZE_PCT,
        minClaimAmountUsd: parsed.DLMM_MIN_CLAIM_AMOUNT_USD,
        autoSwapAfterClaim: parsed.DLMM_AUTO_SWAP_AFTER_CLAIM,
        outOfRangeBinsToClose: parsed.DLMM_OUT_OF_RANGE_BINS_TO_CLOSE,
        outOfRangeWaitMinutes: parsed.DLMM_OUT_OF_RANGE_WAIT_MINUTES,
        oorCooldownTriggerCount: parsed.DLMM_OOR_COOLDOWN_TRIGGER_COUNT,
        oorCooldownHours: parsed.DLMM_OOR_COOLDOWN_HOURS,
        repeatDeployCooldownEnabled: parsed.DLMM_REPEAT_DEPLOY_COOLDOWN_ENABLED,
        repeatDeployCooldownTriggerCount: parsed.DLMM_REPEAT_DEPLOY_COOLDOWN_TRIGGER_COUNT,
        repeatDeployCooldownHours: parsed.DLMM_REPEAT_DEPLOY_COOLDOWN_HOURS,
        repeatDeployCooldownScope: parsed.DLMM_REPEAT_DEPLOY_COOLDOWN_SCOPE,
        repeatDeployCooldownMinFeeEarnedPct: parsed.DLMM_REPEAT_DEPLOY_COOLDOWN_MIN_FEE_EARNED_PCT,
        minVolumeToRebalance: parsed.DLMM_MIN_VOLUME_TO_REBALANCE,
        stopLossPct: parsed.DLMM_STOP_LOSS_PCT,
        takeProfitPct: parsed.DLMM_TAKE_PROFIT_PCT,
        minFeePerTvl24h: parsed.DLMM_MIN_FEE_PER_TVL_24H,
        minAgeBeforeYieldCheckMinutes: parsed.DLMM_MIN_AGE_BEFORE_YIELD_CHECK_MINUTES,
        trailingTakeProfit: parsed.DLMM_TRAILING_TAKE_PROFIT,
        trailingTriggerPct: parsed.DLMM_TRAILING_TRIGGER_PCT,
        trailingDropPct: parsed.DLMM_TRAILING_DROP_PCT,
      },
      strategy: {
        defaultStrategy: parsed.DLMM_DEFAULT_STRATEGY,
        minBinsBelow: parsed.DLMM_MIN_BINS_BELOW,
        maxBinsBelow: parsed.DLMM_MAX_BINS_BELOW,
        defaultBinsBelow: parsed.DLMM_DEFAULT_BINS_BELOW,
      },
      schedule: {
        screeningIntervalMin: parsed.DLMM_SCREENING_INTERVAL_MIN,
        managementIntervalMin: parsed.DLMM_MANAGEMENT_INTERVAL_MIN,
        healthCheckIntervalMin: parsed.DLMM_HEALTH_CHECK_INTERVAL_MIN,
        briefingHourLocal: parsed.DLMM_BRIEFING_HOUR_LOCAL,
      },
      llm: {
        temperature: parsed.DLMM_LLM_TEMPERATURE,
        maxTokens: parsed.DLMM_LLM_MAX_TOKENS,
        maxSteps: parsed.DLMM_LLM_MAX_STEPS,
        managementModel: parsed.DLMM_MANAGEMENT_MODEL || parsed.MODEL,
        screeningModel: parsed.DLMM_SCREENING_MODEL || parsed.MODEL,
        generalModel: parsed.DLMM_GENERAL_MODEL || parsed.MODEL,
      },
      integrations: {
        telegram: {
          operatorChatId: parsed.DLMM_TELEGRAM_OPERATOR_CHAT_ID,
          allowedUserIds: parsed.DLMM_TELEGRAM_ALLOWED_USER_IDS,
        },
        discord: {
          enabled: parsed.DLMM_DISCORD_ENABLED,
          token: parsed.DLMM_DISCORD_TOKEN,
          guildIds: parsed.DLMM_DISCORD_GUILD_IDS,
          channelIds: parsed.DLMM_DISCORD_CHANNEL_IDS,
          authorName: parsed.DLMM_DISCORD_AUTHOR_NAME,
        },
        hiveMind: {
          enabled: parsed.DLMM_HIVEMIND_ENABLED,
          url: parsed.DLMM_HIVEMIND_URL,
          apiKey: parsed.DLMM_HIVEMIND_API_KEY,
          agentId: parsed.DLMM_HIVEMIND_AGENT_ID,
        },
        jupiter: {
          apiKey: parsed.DLMM_JUPITER_API_KEY,
          referralAccount: parsed.DLMM_JUPITER_REFERRAL_ACCOUNT,
          referralFeeBps: parsed.DLMM_JUPITER_REFERRAL_FEE_BPS,
        },
      },
      selfUpdate: {
        enabled: parsed.DLMM_ALLOW_SELF_UPDATE,
        branch: parsed.DLMM_SELF_UPDATE_BRANCH,
        restartCommand: parsed.DLMM_SELF_UPDATE_RESTART_COMMAND,
      },
    },
```

- [ ] **Step 5: Document initial env vars**

Append this section to `.env.example`:

```dotenv
# ── dlmm Full Port ────────────────────────────────────────────────────────────
DLMM_ENABLED=false
DLMM_DRY_RUN=true
DLMM_WALLET_PRIVATE_KEY=
DLMM_RPC_URL=
DLMM_HELIUS_API_KEY=
DLMM_LPAGENT_API_KEY=
DLMM_MAX_POSITIONS=3
DLMM_MAX_DEPLOY_AMOUNT_SOL=50
DLMM_GAS_RESERVE_SOL=0.2
DLMM_DEPLOY_AMOUNT_SOL=0.5
DLMM_MIN_SOL_TO_OPEN=0.55
DLMM_POSITION_SIZE_PCT=0.35
DLMM_MIN_TVL=10000
DLMM_MAX_TVL=150000
DLMM_MIN_VOLUME=500
DLMM_MIN_ORGANIC=60
DLMM_MIN_HOLDERS=500
DLMM_MIN_MCAP=150000
DLMM_MAX_MCAP=10000000
DLMM_MIN_BIN_STEP=80
DLMM_MAX_BIN_STEP=125
DLMM_BLOCKED_LAUNCHPADS=
DLMM_ALLOWED_LAUNCHPADS=
DLMM_MIN_BINS_BELOW=35
DLMM_MAX_BINS_BELOW=69
DLMM_SCREENING_INTERVAL_MIN=30
DLMM_MANAGEMENT_INTERVAL_MIN=10
DLMM_HEALTH_CHECK_INTERVAL_MIN=30
DLMM_MANAGEMENT_MODEL=
DLMM_SCREENING_MODEL=
DLMM_GENERAL_MODEL=
DLMM_TELEGRAM_OPERATOR_CHAT_ID=
DLMM_TELEGRAM_ALLOWED_USER_IDS=
DLMM_DISCORD_ENABLED=false
DLMM_DISCORD_TOKEN=
DLMM_DISCORD_GUILD_IDS=
DLMM_DISCORD_CHANNEL_IDS=
DLMM_DISCORD_AUTHOR_NAME=Metlex Pool Bot
DLMM_HIVEMIND_ENABLED=false
DLMM_HIVEMIND_URL=
DLMM_HIVEMIND_API_KEY=
DLMM_HIVEMIND_AGENT_ID=
DLMM_JUPITER_API_KEY=
DLMM_JUPITER_REFERRAL_ACCOUNT=
DLMM_JUPITER_REFERRAL_FEE_BPS=0
DLMM_ALLOW_SELF_UPDATE=false
DLMM_SELF_UPDATE_BRANCH=main
DLMM_SELF_UPDATE_RESTART_COMMAND=pm2 restart dlmm-agent
```

- [ ] **Step 6: Run env tests and verify they pass**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: PASS.

### Task 2: Add dlmm runtime paths

**Files:**
- Modify: `src/utils/paths.ts`
- Modify: `src/config/env.test.ts`

- [ ] **Step 1: Write failing path assertions**

In `src/config/env.test.ts`, inside `returns the expected auth, logs, and memory paths`, add these assertions after the `memoryDir` assertion:

```ts
expect(paths.dlmmDir).toBe(path.join(path.resolve(root), "dlmm"));
expect(paths.dlmmLogsDir).toBe(path.join(paths.dlmmDir, "logs"));
expect(paths.dlmmStateFile).toBe(path.join(paths.dlmmDir, "state.json"));
expect(paths.dlmmPoolMemoryFile).toBe(path.join(paths.dlmmDir, "pool-memory.json"));
expect(paths.dlmmLessonsFile).toBe(path.join(paths.dlmmDir, "lessons.json"));
expect(paths.dlmmDecisionLogFile).toBe(path.join(paths.dlmmDir, "decision-log.json"));
expect(paths.dlmmSignalWeightsFile).toBe(path.join(paths.dlmmDir, "signal-weights.json"));
expect(paths.dlmmStrategyLibraryFile).toBe(path.join(paths.dlmmDir, "strategy-library.json"));
expect(paths.dlmmSmartWalletsFile).toBe(path.join(paths.dlmmDir, "smart-wallets.json"));
expect(paths.dlmmDiscordSignalsFile).toBe(path.join(paths.dlmmDir, "discord-signals.json"));
```

- [ ] **Step 2: Run path test and verify it fails**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: FAIL because `AppPaths` does not include dlmm paths.

- [ ] **Step 3: Implement path additions**

Update `AppPaths` in `src/utils/paths.ts`:

```ts
export interface AppPaths {
  root: string;
  authDir: string;
  logsDir: string;
  memoryDir: string;
  dlmmDir: string;
  dlmmLogsDir: string;
  pendingCodesFile: string;
  verifiedUsersFile: string;
  verificationLogFile: string;
  dlmmStateFile: string;
  dlmmPoolMemoryFile: string;
  dlmmLessonsFile: string;
  dlmmDecisionLogFile: string;
  dlmmSignalWeightsFile: string;
  dlmmStrategyLibraryFile: string;
  dlmmSmartWalletsFile: string;
  dlmmDiscordSignalsFile: string;
}
```

In `resolveDataPaths()`, add:

```ts
const dlmmDir = path.join(root, "dlmm");
const dlmmLogsDir = path.join(dlmmDir, "logs");
```

Return the new fields:

```ts
    dlmmDir,
    dlmmLogsDir,
    dlmmStateFile: path.join(dlmmDir, "state.json"),
    dlmmPoolMemoryFile: path.join(dlmmDir, "pool-memory.json"),
    dlmmLessonsFile: path.join(dlmmDir, "lessons.json"),
    dlmmDecisionLogFile: path.join(dlmmDir, "decision-log.json"),
    dlmmSignalWeightsFile: path.join(dlmmDir, "signal-weights.json"),
    dlmmStrategyLibraryFile: path.join(dlmmDir, "strategy-library.json"),
    dlmmSmartWalletsFile: path.join(dlmmDir, "smart-wallets.json"),
    dlmmDiscordSignalsFile: path.join(dlmmDir, "discord-signals.json"),
```

In `ensureRuntimeDirectories()`, add:

```ts
await fs.mkdir(paths.dlmmDir, { recursive: true });
await fs.mkdir(paths.dlmmLogsDir, { recursive: true });
```

- [ ] **Step 4: Run path tests and verify they pass**

Run:

```bash
bun test src/config/env.test.ts
```

Expected: PASS.

### Task 3: Add dlmm state contracts and JSON repositories

**Files:**
- Create: `src/dlmm/state/types.ts`
- Create: `src/dlmm/state/json-store.ts`
- Create: `src/dlmm/state/repositories.ts`
- Create: `src/dlmm/state/repositories.test.ts`
- Create: `src/dlmm/index.ts`

- [ ] **Step 1: Write failing repository tests**

Create `src/dlmm/state/repositories.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDlmmRepositories } from "./repositories.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dlmm-state-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("createDlmmRepositories", () => {
  test("loads defaults for missing files", async () => {
    await withTempDir(async (dir) => {
      const repos = createDlmmRepositories({
        stateFile: path.join(dir, "state.json"),
        poolMemoryFile: path.join(dir, "pool-memory.json"),
        lessonsFile: path.join(dir, "lessons.json"),
        decisionLogFile: path.join(dir, "decision-log.json"),
        signalWeightsFile: path.join(dir, "signal-weights.json"),
        strategyLibraryFile: path.join(dir, "strategy-library.json"),
        smartWalletsFile: path.join(dir, "smart-wallets.json"),
        discordSignalsFile: path.join(dir, "discord-signals.json"),
      });

      expect(await repos.state.load()).toEqual({ positions: {}, recentEvents: [], lastUpdated: null, lastBriefingDate: null });
      expect(await repos.poolMemory.load()).toEqual({ pools: {} });
      expect(await repos.lessons.load()).toEqual({ lessons: [], performance: [] });
      expect(await repos.decisionLog.load()).toEqual({ decisions: [] });
      expect(await repos.signalWeights.load()).toEqual({ weights: {}, lastRecalc: null, recalcCount: 0, history: [] });
      expect(await repos.strategyLibrary.load()).toEqual({ active: null, strategies: {} });
      expect(await repos.smartWallets.load()).toEqual({ wallets: [] });
      expect(await repos.discordSignals.load()).toEqual({ signals: [] });
    });
  });

  test("round trips state data", async () => {
    await withTempDir(async (dir) => {
      const repos = createDlmmRepositories({
        stateFile: path.join(dir, "state.json"),
        poolMemoryFile: path.join(dir, "pool-memory.json"),
        lessonsFile: path.join(dir, "lessons.json"),
        decisionLogFile: path.join(dir, "decision-log.json"),
        signalWeightsFile: path.join(dir, "signal-weights.json"),
        strategyLibraryFile: path.join(dir, "strategy-library.json"),
        smartWalletsFile: path.join(dir, "smart-wallets.json"),
        discordSignalsFile: path.join(dir, "discord-signals.json"),
      });

      await repos.state.save({
        positions: {
          pos1: {
            positionId: "pos1",
            poolAddress: "pool1",
            poolName: "TOKEN/SOL",
            strategy: "spot",
            binRange: { lowerBinId: 1, upperBinId: 10 },
            amountSol: 0.5,
            deployedAt: "2026-05-24T00:00:00.000Z",
            closed: false,
            totalFeesClaimedUsd: 0,
            rebalanceCount: 0,
            notes: [],
          },
        },
        recentEvents: [{ type: "deploy", message: "opened pos1", timestamp: "2026-05-24T00:00:00.000Z" }],
        lastUpdated: "2026-05-24T00:00:00.000Z",
        lastBriefingDate: null,
      });

      const loaded = await repos.state.load();
      expect(loaded.positions.pos1.poolAddress).toBe("pool1");
      expect(loaded.recentEvents[0]?.type).toBe("deploy");
    });
  });

  test("returns defaults for corrupt JSON", async () => {
    await withTempDir(async (dir) => {
      const stateFile = path.join(dir, "state.json");
      await writeFile(stateFile, "not-json", "utf8");
      const repos = createDlmmRepositories({
        stateFile,
        poolMemoryFile: path.join(dir, "pool-memory.json"),
        lessonsFile: path.join(dir, "lessons.json"),
        decisionLogFile: path.join(dir, "decision-log.json"),
        signalWeightsFile: path.join(dir, "signal-weights.json"),
        strategyLibraryFile: path.join(dir, "strategy-library.json"),
        smartWalletsFile: path.join(dir, "smart-wallets.json"),
        discordSignalsFile: path.join(dir, "discord-signals.json"),
      });

      expect(await repos.state.load()).toEqual({ positions: {}, recentEvents: [], lastUpdated: null, lastBriefingDate: null });
    });
  });
});
```

- [ ] **Step 2: Run repository tests and verify they fail**

Run:

```bash
bun test src/dlmm/state/repositories.test.ts
```

Expected: FAIL because repository files do not exist.

- [ ] **Step 3: Create state types**

Create `src/dlmm/state/types.ts` with the interfaces used by repositories:

```ts
export interface DlmmState {
  positions: Record<string, DlmmPosition>;
  recentEvents: DlmmEvent[];
  lastUpdated: string | null;
  lastBriefingDate: string | null;
}

export interface DlmmPosition {
  positionId: string;
  poolAddress: string;
  poolName: string;
  strategy: string;
  binRange: { lowerBinId: number; upperBinId: number };
  amountSol: number;
  amountToken?: number;
  activeBinAtDeploy?: number;
  binStep?: number;
  volatility?: number;
  feeTvlRatio?: number;
  organicScore?: number;
  initialValueUsd?: number;
  signalSnapshot?: Record<string, unknown>;
  deployedAt: string;
  outOfRangeSince?: string | null;
  lastClaimAt?: string | null;
  totalFeesClaimedUsd: number;
  rebalanceCount: number;
  closed: boolean;
  closedAt?: string | null;
  notes: string[];
  instruction?: string;
  peakPnlPct?: number;
  trailingActive?: boolean;
  pendingPeakPnlPct?: number;
  pendingPeakStartedAt?: string | null;
  pendingTrailingCurrentPnlPct?: number;
  pendingTrailingPeakPnlPct?: number;
  pendingTrailingDropPct?: number;
  pendingTrailingStartedAt?: string | null;
  confirmedTrailingExitReason?: string | null;
  confirmedTrailingExitUntil?: string | null;
}

export interface DlmmEvent {
  type: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface DlmmPoolMemoryStore {
  pools: Record<string, DlmmPoolMemory>;
}

export interface DlmmPoolMemory {
  name: string;
  baseMint?: string;
  deploys: DlmmPoolDeploy[];
  totalDeploys: number;
  avgPnlPct: number;
  winRate: number;
  adjustedWinRate: number;
  adjustedWinRateSampleCount: number;
  lastDeployedAt: string | null;
  lastOutcome: string | null;
  notes: DlmmPoolNote[];
  snapshots: DlmmPoolSnapshot[];
  cooldownUntil?: string | null;
  cooldownReason?: string | null;
  baseMintCooldownUntil?: string | null;
  baseMintCooldownReason?: string | null;
}

export interface DlmmPoolDeploy {
  deployedAt: string;
  closedAt?: string | null;
  pnlPct?: number;
  pnlUsd?: number;
  feesEarnedUsd?: number;
  feesEarnedSol?: number;
  feeEarnedPct?: number;
  rangeEfficiency?: number;
  minutesHeld?: number;
  closeReason?: string;
  strategy?: string;
  volatilityAtDeploy?: number;
}

export interface DlmmPoolNote {
  note: string;
  addedAt: string;
}

export interface DlmmPoolSnapshot {
  timestamp: string;
  positionId: string;
  pnlPct?: number;
  pnlUsd?: number;
  inRange?: boolean;
  unclaimedFeesUsd?: number;
  minutesOutOfRange?: number;
  ageMinutes?: number;
}

export interface DlmmLessonsStore {
  lessons: DlmmLesson[];
  performance: DlmmPerformanceRecord[];
}

export interface DlmmLesson {
  id: string;
  rule: string;
  tags: string[];
  outcome: string;
  sourceType: string;
  pinned: boolean;
  role: "screener" | "manager" | "general" | "all";
  createdAt: string;
}

export interface DlmmPerformanceRecord {
  positionId: string;
  poolAddress: string;
  pnlUsd: number;
  pnlPct: number;
  rangeEfficiency?: number;
  signalSnapshot?: Record<string, unknown>;
  deployedAt?: string;
  closedAt?: string;
  recordedAt: string;
}

export interface DlmmDecisionLogStore {
  decisions: DlmmDecision[];
}

export interface DlmmDecision {
  id: string;
  timestamp: string;
  type: string;
  actor: string;
  poolAddress?: string | null;
  poolName?: string | null;
  positionId?: string | null;
  summary: string;
  reason: string;
  risks: string[];
  metrics: Record<string, unknown>;
  rejected: string[];
}

export interface DlmmSignalWeightsStore {
  weights: Record<string, number>;
  lastRecalc: string | null;
  recalcCount: number;
  history: DlmmSignalWeightHistory[];
}

export interface DlmmSignalWeightHistory {
  timestamp: string;
  changes: Array<{ signal: string; from: number; to: number; lift: number; action: string }>;
  windowSize: number;
  winCount: number;
  lossCount: number;
}

export interface DlmmStrategyLibraryStore {
  active: string | null;
  strategies: Record<string, DlmmStrategy>;
}

export interface DlmmStrategy {
  id: string;
  name: string;
  author: string;
  lpStrategy: string;
  tokenCriteria: Record<string, unknown>;
  entry: Record<string, unknown>;
  range: Record<string, unknown>;
  exit: Record<string, unknown>;
  bestFor: string;
  raw?: string;
  addedAt: string;
  updatedAt: string;
}

export interface DlmmSmartWalletStore {
  wallets: DlmmSmartWallet[];
}

export interface DlmmSmartWallet {
  name: string;
  address: string;
  category: string;
  type: "lp" | "holder" | string;
  addedAt: string;
}

export interface DlmmDiscordSignalsStore {
  signals: DlmmDiscordSignal[];
}

export interface DlmmDiscordSignal {
  id: string;
  poolAddress: string;
  sourceMessageId: string;
  guildId?: string;
  channelId?: string;
  authorName?: string;
  rawText: string;
  status: "pending" | "consumed" | "rejected";
  createdAt: string;
  consumedAt?: string | null;
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 4: Create JSON store helper**

Create `src/dlmm/state/json-store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface JsonStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
}

export function createJsonStore<T>(filePath: string, createDefault: () => T): JsonStore<T> {
  return {
    async load(): Promise<T> {
      try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content) as T;
      } catch {
        return createDefault();
      }
    },
    async save(value: T): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
  };
}
```

- [ ] **Step 5: Create repository factory**

Create `src/dlmm/state/repositories.ts`:

```ts
import { createJsonStore, type JsonStore } from "./json-store.ts";
import type {
  DlmmDecisionLogStore,
  DlmmDiscordSignalsStore,
  DlmmLessonsStore,
  DlmmPoolMemoryStore,
  DlmmSignalWeightsStore,
  DlmmSmartWalletStore,
  DlmmState,
  DlmmStrategyLibraryStore,
} from "./types.ts";

export interface DlmmRepositoryPaths {
  stateFile: string;
  poolMemoryFile: string;
  lessonsFile: string;
  decisionLogFile: string;
  signalWeightsFile: string;
  strategyLibraryFile: string;
  smartWalletsFile: string;
  discordSignalsFile: string;
}

export interface DlmmRepositories {
  state: JsonStore<DlmmState>;
  poolMemory: JsonStore<DlmmPoolMemoryStore>;
  lessons: JsonStore<DlmmLessonsStore>;
  decisionLog: JsonStore<DlmmDecisionLogStore>;
  signalWeights: JsonStore<DlmmSignalWeightsStore>;
  strategyLibrary: JsonStore<DlmmStrategyLibraryStore>;
  smartWallets: JsonStore<DlmmSmartWalletStore>;
  discordSignals: JsonStore<DlmmDiscordSignalsStore>;
}

export function createDlmmRepositories(paths: DlmmRepositoryPaths): DlmmRepositories {
  return {
    state: createJsonStore(paths.stateFile, () => ({ positions: {}, recentEvents: [], lastUpdated: null, lastBriefingDate: null })),
    poolMemory: createJsonStore(paths.poolMemoryFile, () => ({ pools: {} })),
    lessons: createJsonStore(paths.lessonsFile, () => ({ lessons: [], performance: [] })),
    decisionLog: createJsonStore(paths.decisionLogFile, () => ({ decisions: [] })),
    signalWeights: createJsonStore(paths.signalWeightsFile, () => ({ weights: {}, lastRecalc: null, recalcCount: 0, history: [] })),
    strategyLibrary: createJsonStore(paths.strategyLibraryFile, () => ({ active: null, strategies: {} })),
    smartWallets: createJsonStore(paths.smartWalletsFile, () => ({ wallets: [] })),
    discordSignals: createJsonStore(paths.discordSignalsFile, () => ({ signals: [] })),
  };
}
```

- [ ] **Step 6: Create public exports**

Create `src/dlmm/index.ts`:

```ts
export type { DlmmConfig } from "./config/types.ts";
export { createDlmmRepositories } from "./state/repositories.ts";
export type { DlmmRepositories, DlmmRepositoryPaths } from "./state/repositories.ts";
export type * from "./state/types.ts";
```

- [ ] **Step 7: Run repository tests and verify they pass**

Run:

```bash
bun test src/dlmm/state/repositories.test.ts
```

Expected: PASS.

### Task 4: Verify Phase 1 together

**Files:**
- All Phase 1 files

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/config/env.test.ts src/dlmm/state/repositories.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 3: Build**

Run:

```bash
bun run build
```

Expected: PASS and output under `dist/`.

---

## Phase 2: Full standalone prompts

### Task 5: Add shared prompt context and full prompt builders

**Files:**
- Create: `src/dlmm/prompts/shared-context.ts`
- Create: `src/dlmm/prompts/screener-prompt.ts`
- Create: `src/dlmm/prompts/manager-prompt.ts`
- Create: `src/dlmm/prompts/general-prompt.ts`
- Create: `src/dlmm/prompts/briefing-prompt.ts`
- Create: `src/dlmm/prompts/self-update-prompt.ts`
- Create: `src/dlmm/prompts/discord-signal-prompt.ts`
- Create: `src/dlmm/prompts/prompts.test.ts`

- [ ] Write tests that build every prompt with fixture config/state and assert each prompt includes role identity, safety rules, tool rules, dry-run rules, current positions, lessons, pool memory, signal weights, strategy library, blacklists, Discord signals when relevant, response format, and failure behavior.
- [ ] Implement `formatSharedDlmmContext(input)` in `shared-context.ts` so all prompt builders share the same complete runtime context without duplicating formatting code.
- [ ] Implement each prompt builder as a complete standalone system prompt, not a fragment.
- [ ] Run `bun test src/dlmm/prompts/prompts.test.ts` and then `bun run test`.

### Task 6: Export prompts from dlmm index

**Files:**
- Modify: `src/dlmm/index.ts`

- [ ] Export every prompt builder.
- [ ] Run `bun test src/dlmm/prompts/prompts.test.ts`.

---

## Phase 3: Core dlmm trading adapters and safety checks

### Task 7: Add core action types and dry-run service

**Files:**
- Create: `src/dlmm/core/types.ts`
- Create: `src/dlmm/core/safety.ts`
- Create: `src/dlmm/core/service.ts`
- Create: `src/dlmm/core/safety.test.ts`
- Create: `src/dlmm/core/service.test.ts`

- [ ] Test deploy validation for bin-step bounds, positive volatility, minimum range width, max positions, duplicate pool, duplicate base mint, SOL balance plus gas reserve, and SOL-only deploys.
- [ ] Implement pure safety functions before SDK calls.
- [ ] Implement a dry-run `DlmmCoreService` that returns deterministic deploy/close/claim/PnL/pool-search results without chain access.
- [ ] Run `bun test src/dlmm/core/`.

### Task 8: Add external adapter interfaces

**Files:**
- Create: `src/dlmm/integrations/meteora.ts`
- Create: `src/dlmm/integrations/solana.ts`
- Create: `src/dlmm/integrations/helius.ts`
- Create: `src/dlmm/integrations/jupiter.ts`
- Create: `src/dlmm/integrations/types.ts`

- [ ] Define interfaces for pool lookup, active bin lookup, deploy, close, claim, wallet positions, token audit, and balance queries.
- [ ] Keep implementation minimal in this phase: throw explicit `not implemented` errors for live operations while dry-run service remains usable.
- [ ] Run `bun test src/dlmm/core/` and `bun run build`.

---

## Phase 4: Learning and persistent stores

### Task 9: Port strategy library, smart wallets, blacklists, pool memory, lessons, and signal weights

**Files:**
- Create: `src/dlmm/learning/strategy-library.ts`
- Create: `src/dlmm/learning/smart-wallets.ts`
- Create: `src/dlmm/learning/blacklists.ts`
- Create: `src/dlmm/learning/pool-memory.ts`
- Create: `src/dlmm/learning/lessons.ts`
- Create: `src/dlmm/learning/signal-weights.ts`
- Create: `src/dlmm/learning/*.test.ts`

- [ ] Write tests for default strategies, active strategy selection, smart wallet add/remove/list, blacklist matching, pool cooldowns, lesson recording, and signal-weight recalculation.
- [ ] Implement modules against Phase 1 repositories.
- [ ] Preserve source behavior, but use camelCase typed fields.
- [ ] Run `bun test src/dlmm/learning/`.

---

## Phase 5: Screening

### Task 10: Port candidate discovery, filtering, scoring, and deploy orchestration

**Files:**
- Create: `src/dlmm/screening/types.ts`
- Create: `src/dlmm/screening/filters.ts`
- Create: `src/dlmm/screening/signals.ts`
- Create: `src/dlmm/screening/service.ts`
- Create: `src/dlmm/screening/*.test.ts`

- [ ] Test launchpad, blacklist, holder, bundler, top-holder, TVL, volume, market-cap, token-age, bin-step, and volatility filters.
- [ ] Test signal staging and retrieval.
- [ ] Test dry-run screening consumes pending Discord signals and produces deploy decisions without live chain calls.
- [ ] Implement screening service using adapters and Phase 4 learning modules.
- [ ] Run `bun test src/dlmm/screening/`.

---

## Phase 6: Management

### Task 11: Port position monitoring and action decisions

**Files:**
- Create: `src/dlmm/management/types.ts`
- Create: `src/dlmm/management/rules.ts`
- Create: `src/dlmm/management/service.ts`
- Create: `src/dlmm/management/*.test.ts`

- [ ] Test OOR detection, stop loss, take profit, trailing take profit, claim thresholds, close decisions, cooldown updates, and learning updates.
- [ ] Implement management service against core service and repositories.
- [ ] Run `bun test src/dlmm/management/`.

---

## Phase 7: Runtime schedulers and lifecycle

### Task 12: Add schedulers, race guards, and lifecycle service

**Files:**
- Create: `src/dlmm/runtime/scheduler.ts`
- Create: `src/dlmm/runtime/service.ts`
- Create: `src/dlmm/runtime/service.test.ts`
- Modify: `src/main.ts`

- [ ] Test screening and management cannot overlap with themselves.
- [ ] Test `start()` schedules enabled loops and `close()` clears timers.
- [ ] Wire `DlmmRuntimeService` in `src/main.ts` only when `env.dlmm.enabled` is true.
- [ ] Ensure shutdown calls `dlmmRuntime.close()` before logger close.
- [ ] Run `bun test src/dlmm/runtime/` and `bun run test`.

---

## Phase 8: Telegram hybrid ops and briefing

### Task 13: Add dlmm Telegram command router and alert formatter

**Files:**
- Create: `src/dlmm/ops/telegram-router.ts`
- Create: `src/dlmm/ops/alerts.ts`
- Create: `src/dlmm/ops/briefing.ts`
- Create: `src/dlmm/ops/*.test.ts`
- Modify: `src/telegram/bot.ts` or `src/telegram/handler.ts`

- [ ] Test `/dlmm positions`, `/dlmm close`, `/dlmm set`, `/dlmm screen`, `/dlmm manage`, `/dlmm briefing`, `/dlmm lessons`, `/dlmm strategies`, `/dlmm wallets`, `/dlmm blacklist`, and `/dlmm self-update` routing.
- [ ] Test alert formatting for deploy, close, claim, swap, and OOR events.
- [ ] Test briefing generation from state and lessons.
- [ ] Wire the router without breaking existing verification/chat behavior.
- [ ] Run Telegram focused tests and `bun run test`.

---

## Phase 9: Discord sidecar

### Task 14: Port Discord listener behavior as a sidecar

**Files:**
- Create: `src/dlmm/discord-listener/extract.ts`
- Create: `src/dlmm/discord-listener/queue.ts`
- Create: `src/dlmm/discord-listener/index.ts`
- Create: `src/dlmm/discord-listener/*.test.ts`
- Modify: `package.json`

- [ ] Test Solana address extraction from text and embeds.
- [ ] Test configured guild/channel/author filtering.
- [ ] Test pending signal queue writes to `data/dlmm/discord-signals.json`.
- [ ] Add a sidecar script such as `dlmm:discord` that starts the listener.
- [ ] Run `bun test src/dlmm/discord-listener/`.

---

## Phase 10: External integrations and live adapters

### Task 15: Implement live adapter paths behind dry-run gates

**Files:**
- Modify: `src/dlmm/integrations/*.ts`
- Modify: `package.json`

- [ ] Add required dependencies only after confirming they are needed in target runtime.
- [ ] Implement Meteora, Solana, Helius, Jupiter, HiveMind, and LPAgent adapters behind interfaces.
- [ ] Keep tests mocked; do not require real credentials for unit tests.
- [ ] Run `bun run build` and `bun run test`.

---

## Phase 11: Self-update and PM2/Bun deployment

### Task 16: Add gated self-update service

**Files:**
- Create: `src/dlmm/ops/self-update.ts`
- Create: `src/dlmm/ops/self-update.test.ts`

- [ ] Test self-update refuses when disabled.
- [ ] Test dirty working tree blocks update.
- [ ] Test generated command sequence uses non-destructive git pull/install/restart steps.
- [ ] Implement command planning; execute commands only through an injected runner.
- [ ] Run `bun test src/dlmm/ops/self-update.test.ts`.

### Task 17: Add PM2/Bun deployment support

**Files:**
- Create or modify: `ecosystem.config.cjs`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] Add main Bun process and Discord sidecar process.
- [ ] Document dry-run first-run procedure.
- [ ] Document restart and log commands.
- [ ] Run `bun run build`.

---

## Phase 12: Integration and production-style dry-run tests

### Task 18: Add end-to-end dry-run coverage

**Files:**
- Create: `test/prod/dlmm-dry-run.test.ts`
- Create: `src/dlmm/integration.test.ts`

- [ ] Test runtime starts with dlmm enabled and dry-run true using temp data paths.
- [ ] Test screening consumes a queued Discord signal and records a dry-run decision.
- [ ] Test management reads an open position and records a hold/close decision without live chain calls.
- [ ] Run `bun run test` and `bun run test:prod`.

---

## Final verification

- [ ] Run focused dlmm tests:

```bash
bun test src/dlmm/
```

Expected: PASS.

- [ ] Run all unit tests:

```bash
bun run test
```

Expected: PASS.

- [ ] Run production-style tests:

```bash
bun run test:prod
```

Expected: PASS.

- [ ] Build:

```bash
bun run build
```

Expected: PASS.

## Self-review

- Spec coverage: all approved design areas map to a phase: config/state, prompts, core trading, learning, screening, management, Telegram, Discord, external adapters, PM2, self-update, integration tests.
- Placeholder scan: no `TBD`, `TODO`, or unspecified placeholder sections are used.
- Type consistency: `DlmmConfig`, `DlmmRepositories`, repository file names, and `data/dlmm/**` paths are consistent across phases.
