# dlmm Full Port Design

**Reference source:** `D:\code\bot\meridian` is the source repository for behavior parity. The ported subsystem name is `dlmm` everywhere in the target repository.

**Target repository:** `D:\code\bot\agent`

**Goal:** Port the full dlmm trading daemon behavior into the target Bun/TypeScript agent while keeping the implementation isolated, testable, and target-native.

## Scope

The port includes full behavior parity for:

- core DLMM trading actions: deploy, close, claim fees, active bin lookup, wallet positions, pool search, and PnL;
- all source safety guardrails: max positions, duplicate pool/base token prevention, bin-step bounds, volatility/range validation, SOL-only deploys, gas reserve, cooldowns, transaction simulation, and relay safety checks;
- autonomous screening, management, health checks, and race guards;
- state, pool memory, lessons, decision log, signal weights, strategy library, blacklists, and smart wallet tracking;
- full standalone prompts for every dlmm role;
- hybrid Telegram operations, including commands, alerts, live updates, and briefings;
- Discord signal listener behavior as a sidecar process;
- HiveMind, LPAgent, Helius, Jupiter, Meteora DLMM SDK, Solana RPC, and OpenAI-compatible LLM integrations;
- PM2 supervision for Bun processes;
- self-update as a controlled operator command/script;
- dry-run mode and automated Bun test coverage.

The port does not copy the source daemon as a monolith. It preserves behavior while adapting module boundaries, configuration, storage, tests, and runtime integration to the target repository.

## Architecture

Create a new self-contained subsystem under `src/dlmm/`:

```text
src/dlmm/
  core/             # deploy, close, claim, positions, PnL, active bin, pool search
  screening/        # candidate discovery, filters, scoring, Discord queue intake
  management/       # open-position monitoring, OOR logic, TP/SL/trailing exits
  state/            # typed JSON stores under data/dlmm/**
  learning/         # lessons, pool memory, signal weights, strategy library
  integrations/     # Meteora, Solana RPC, Helius, Jupiter, HiveMind, LPAgent
  ops/              # Telegram commands, alerts, briefings, self-update
  discord-listener/ # Discord listener sidecar with source-compatible behavior
  runtime/          # scheduler, lifecycle, startup/shutdown, PM2/Bun process glue
  tools/            # agent tool schemas and dispatch for dlmm actions
  prompts/          # complete system prompt builders for each dlmm role
```

The target application should wire dlmm through `src/main.ts` with a small lifecycle boundary: initialize config, create repositories and adapters, start schedulers when enabled, attach Telegram ops routing, and register shutdown handlers. Core trading and external calls must not be embedded directly in `src/main.ts`.

Runtime data lives under `data/dlmm/`:

```text
data/dlmm/
  state.json
  pool-memory.json
  lessons.json
  decision-log.json
  signal-weights.json
  strategy-library.json
  smart-wallets.json
  discord-signals.json
  logs/
```

The port must not write root-level runtime JSON files in the target repository.

## Configuration

Keep dlmm configuration in a dedicated module so the target app config does not become ambiguous. `src/dlmm/config/env.ts` owns the `DLMM_*` Zod schema and exports `parseDlmmEnv(input, defaults)`. `src/config/env.ts` only composes that parsed result into `AppEnv` as `env.dlmm`. `.env.example` remains the single environment example file for the whole app.

Secrets and infrastructure config come from env. Mutable runtime state goes under `data/dlmm/**`.

Required configuration groups:

- enablement: enabled, dry-run, log level;
- wallet/RPC: wallet private key, RPC URL, Helius key;
- risk: max positions, max deploy amount, gas reserve, min SOL to open, position size percent;
- screening: TVL, volume, holder, market-cap, bin-step, launchpad, bundler, top-holder, token-age, and fee thresholds;
- management: claim thresholds, OOR wait, OOR cooldowns, repeat-deploy cooldowns, stop loss, take profit, trailing take profit, rebalance thresholds;
- strategy: default strategy, bins-below formula bounds, active strategy library;
- schedule: screening interval, management interval, health interval, briefing time;
- LLM: provider/base URL/API key/model per role, temperature, max tokens, max steps;
- integrations: HiveMind, LPAgent, Jupiter, Discord, Telegram operator destinations;
- self-update: allow/deny flag, branch/ref policy, restart command.

## Full prompt requirements

The port must include complete prompt templates, not partial snippets or appended fragments. Store prompt builders in:

```text
src/dlmm/prompts/
  shared-context.ts
  screener-prompt.ts
  manager-prompt.ts
  general-prompt.ts
  briefing-prompt.ts
  self-update-prompt.ts
  discord-signal-prompt.ts
```

Each prompt builder returns a complete standalone system prompt suitable for the dlmm agent/tool loop. Each full prompt must include:

- role identity and mission;
- operating constraints;
- safety rules;
- exact tool-use rules;
- dry-run behavior;
- current config values;
- wallet and risk limits;
- open positions;
- recent events;
- lessons;
- pool memory;
- signal weights;
- active strategy;
- strategy library summaries;
- token/deployer/dev blacklists;
- Discord signals when relevant;
- deploy, close, claim, screening, and management decision rules;
- expected response format;
- refusal/failure behavior.

The prompt API should be explicit and testable:

```ts
const prompt = buildDlmmScreenerPrompt({
  config,
  walletSummary,
  openPositions,
  recentEvents,
  lessons,
  poolMemory,
  signalWeights,
  activeStrategy,
  strategyLibrary,
  blacklists,
  discordSignals,
});
```

Prompt tests must assert that critical safety instructions and required context sections are present in the generated full prompt.

## Runtime flows

### Startup

```text
PM2 / Bun process
  -> index.ts
  -> src/main.ts
  -> parse env
  -> create logger and runtime paths
  -> initialize dlmm if enabled
  -> start screening, management, health, Telegram ops, and Discord sidecar integration
  -> register shutdown handlers
```

### Screening

```text
candidate sources
  -> pool discovery and Discord signal intake
  -> blocklist and launchpad filters
  -> holder, bundler, smart-wallet, token, and fee enrichment
  -> strategy, lessons, pool memory, and signal-weight context
  -> full screener prompt/tool decision
  -> deploy safety checks
  -> dry-run or on-chain deploy
  -> state update, pool memory update, decision log, Telegram alert
```

### Management

```text
open positions
  -> active bin, PnL, fee, and OOR checks
  -> stop-loss, take-profit, trailing-TP, claim, close, rebalance, cooldown decisions
  -> full manager prompt/tool decision when needed
  -> dry-run or on-chain action
  -> state update, lessons update, pool memory update, signal-weight recalculation, Telegram alert
```

### Discord listener

```text
dlmm Discord sidecar
  -> watches configured guild/channel/author
  -> extracts Solana addresses from messages and embeds
  -> runs pre-checks
  -> writes data/dlmm/discord-signals.json
  -> screening loop consumes pending signals
```

The Discord listener is included with source-compatible behavior and runs as a separate supervised process to keep listener failures from destabilizing the main agent.

### Telegram operations

Telegram is hybrid:

- the existing target bot may route dlmm commands;
- dlmm alerts, deploy/close notifications, live updates, and briefings go to configured operator chat/channel destinations;
- dlmm command handling stays in `src/dlmm/ops/**` instead of being mixed into generic chat handling.

Required command families:

- status and positions;
- close by index or position id;
- set position note/instruction;
- run screening cycle;
- run management cycle;
- show briefing;
- show lessons and pool memory summaries;
- manage strategy library;
- manage smart wallets and blacklists;
- trigger self-update when enabled.

### Self-update

Self-update is a controlled operator action, not an automatic background mutation. The design must include:

- explicit `DLMM_ALLOW_SELF_UPDATE` gate;
- operator-only Telegram command and script entrypoint;
- working tree status check before update;
- dependency install step when package files change;
- PM2/Bun restart command;
- clear failure reporting to Telegram/logs;
- no force reset, no destructive cleanup, and no hook bypassing.

## PM2 and Bun deployment

PM2 support is part of the full port. The deployment design should supervise:

- main target Bun app with dlmm runtime enabled;
- Discord listener sidecar;
- optional one-shot maintenance scripts.

PM2 configuration must use Bun-compatible commands and keep process names dlmm-oriented. PM2 is supported without making the code depend on PM2 at runtime.

## Testing strategy

Use the target repository's `bun:test` conventions. Tests should be colocated with implementation where practical.

Required automated coverage:

- env parsing and defaulting for `DLMM_*` settings;
- path resolution and JSON repository round trips under `data/dlmm/**`;
- corrupt/missing state file behavior;
- full prompt builders for screener, manager, general, briefing, self-update, and Discord signal roles;
- core safety checks for deploy, close, claim, range, volatility, balance, duplicate pool/base token, gas reserve, cooldowns, and relay simulation;
- dry-run deploy/close/claim paths;
- candidate filtering and scoring;
- signal staging and signal-weight recalculation;
- strategy library operations;
- pool memory and lessons updates;
- Telegram command routing and notification formatting;
- Discord listener extraction and queue writing;
- scheduler race guards and shutdown cleanup;
- self-update safety gates;
- PM2/Bun deployment config validation where implemented.

External systems must be hidden behind adapters for deterministic tests:

- Meteora DLMM SDK;
- Solana RPC;
- Helius;
- Jupiter;
- HiveMind / LPAgent;
- Telegram API;
- Discord listener input;
- OpenAI-compatible LLM client.

## Rollout phases

The implementation plan should break the full port into these phases:

1. Scaffold `src/dlmm/**`, config, paths, and state contracts.
2. Port full standalone prompts and prompt tests.
3. Port core DLMM adapters and safety checks.
4. Port state, pool memory, lessons, signal weights, strategy library, smart wallets, and blacklists.
5. Port screening discovery, filters, scoring, and deploy orchestration.
6. Port management loop, close/claim/rebalance logic, and learning updates.
7. Port hybrid Telegram operations, alerts, live updates, and briefing.
8. Port Discord listener sidecar and queue consumption.
9. Port HiveMind, LPAgent, Helius, Jupiter, and related enrichment adapters.
10. Port self-update and PM2/Bun deployment support.
11. Add integration and production-style dry-run tests.
12. Run full verification and document operation.

## Completion criteria

The port is complete when:

- dlmm runs from the target repository in dry-run mode;
- full standalone prompts are present and tested;
- core trading operations are available through typed services and agent tools;
- autonomous screening and management loops work under target lifecycle management;
- source safety guardrails are preserved or stricter;
- Discord listener writes signals consumed by screening;
- hybrid Telegram ops can read state, trigger actions, send alerts, and run self-update when enabled;
- PM2 can supervise both the Bun main app and Discord sidecar;
- runtime files are stored under `data/dlmm/**`;
- all implemented external integrations have adapter-backed tests or dry-run coverage;
- `bun test` passes for the target repository.

## Design self-review

- Placeholder scan: no placeholder sections remain.
- Consistency check: the subsystem is consistently named `dlmm`; the source repository is referenced only as a path.
- Scope check: this is intentionally a full-port design, but rollout is phased to keep implementation reviewable.
- Ambiguity check: Telegram is hybrid, Discord is a sidecar, PM2 supports Bun, self-update is gated and non-destructive, and prompts must be complete standalone prompts.
