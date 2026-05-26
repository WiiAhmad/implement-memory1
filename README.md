# agent

## Setup

```bash
bun install
cp .env.example .env

ccs codex --dangerously-skip-permissions
```

Running `bun install` at the repo root also installs dependencies in `TencentDB-Agent-Memory/`.

Set all OpenAI and Telegram values in `.env` before starting the bot.

Chat replies automatically retry timeout/abort failures up to 3 times by default.
Tune this with `CHAT_TIMEOUT_RETRIES`; set it to `0` to disable timeout retries.

## Run

```bash
bun run index.ts
```

## Verification flow

1. A new Telegram user sends any text message.
2. The bot writes a one-time verification code to `data/logs/<yyyy-mm-dd>-verification.log`.
3. The user sends that code back in Telegram.
4. After a successful match, the user stays verified for future chats.

## Wallet commands

- `/wallets-gen` - Generate one Solana wallet, save it in SQLite, and reply with the public address only. Each Telegram user can keep up to 10 wallets.
- `/wallets-list` - List your saved wallet public addresses and mark the active wallet.
- `/wallets-now` - Show only your active wallet public address.
- `/wallets-active <public-address>` - Make one of your saved wallets the active wallet.
- `/wallets-delete <public-address>` - Delete one of your saved wallets. If you delete the active wallet, the newest remaining wallet becomes active.
- `/wallets-privatekey <public-address>` - Issue a 6-digit code in the server logs. Send that code as your next Telegram message to reveal the private key. Any other next message cancels the request.

Wallet secrets are not shown by `/wallets-gen`, `/wallets-list`, or `/wallets-now`.

## Memory storage

- Auth files: `data/auth/pending-codes.json`, `data/auth/verified-users.json`
- Verification log: `data/logs/<yyyy-mm-dd>-verification.log`
- TencentDB memory: `data/memory-tdai/`
- Wallet primary database: `data/wallets/wallets.sqlite`
- Wallet backup database: `data/wallets/wallets-backup.sqlite`

## Memory (TDAI) Configuration

The TDAI memory pipeline can be tuned through environment variables. All defaults
match the library's recommended settings for a conversational Telegram bot.

### Store & Capture

| Variable | Default | Description |
|---|---|---|
| `MEMORY_STORE_BACKEND` | `sqlite` | Storage backend (only sqlite supported) |
| `MEMORY_CAPTURE_ENABLED` | `true` | Enable raw conversation recording |
| `MEMORY_L0L1_RETENTION_DAYS` | `0` | Auto-delete L0/L1 memory data older than N days (0 = disabled, minimum effective: 3) |
| `MEMORY_ALLOW_AGGRESSIVE_CLEANUP` | `false` | Allow local memory retention below 3 days |
| `MEMORY_CLEAN_TIME` | `03:00` | Daily memory cleanup time in HH:mm |
| `MEMORY_EXTRACTION_ENABLED` | `true` | Enable memory extraction pipeline |
| `MEMORY_EXTRACTION_DEDUP` | `true` | Deduplicate extracted memories |
| `MEMORY_MAX_MEMORIES` | `20` | Maximum extracted memories kept per session |

### Persona / Scenes

| Variable | Default | Description |
|---|---|---|
| `MEMORY_PERSONA_TRIGGER_N` | `50` | Trigger persona extraction every N conversations |
| `MEMORY_PERSONA_MAX_SCENES` | `20` | Maximum tracked scenes |
| `MEMORY_PERSONA_BACKUP_COUNT` | `3` | Number of persona backup copies |
| `MEMORY_PERSONA_SCENE_BACKUP` | `10` | Number of scene backup copies |

### Pipeline Scheduling

| Variable | Default | Description |
|---|---|---|
| `MEMORY_PIPELINE_EVERY_N` | `10` | Run pipeline every N conversation turns |
| `MEMORY_PIPELINE_WARMUP` | `true` | Warm up pipeline on startup |
| `MEMORY_L1_IDLE_TIMEOUT` | `600` | L1 idle timeout (seconds, 600 = 5 min) |
| `MEMORY_L2_DELAY_AFTER_L1` | `5` | L2 delay after L1 completes (seconds) |
| `MEMORY_L2_MIN_INTERVAL` | `900` | Minimum interval between L2 runs (seconds) |
| `MEMORY_L2_MAX_INTERVAL` | `3600` | Maximum interval between L2 runs (seconds) |
| `MEMORY_SESSION_WINDOW_HOURS` | `24` | Session active window before pipeline deprioritises idle sessions |

### Memory Recall

| Variable | Default | Description |
|---|---|---|
| `MEMORY_RECALL_ENABLED` | `true` | Enable memory recall when building context |
| `MEMORY_RECALL_MAX_RESULTS` | `5` | Maximum number of recalled memories to inject |
| `MEMORY_RECALL_SCORE_THRESHOLD` | `0.3` | Minimum relevance score threshold (0.0–1.0) |
| `MEMORY_RECALL_STRATEGY` | `keyword` | Retrieval strategy |
| `MEMORY_RECALL_TIMEOUT_MS` | `5000` | Recall timeout in milliseconds |

### Embedding & BM25

| Variable | Default | Description |
|---|---|---|
| `MEMORY_EMBEDDING_ENABLED` | `false` | Enable embedding-based retrieval (requires provider) |
| `MEMORY_EMBEDDING_PROVIDER` | `none` | Embedding provider identifier |
| `MEMORY_BM25_ENABLED` | `true` | Enable BM25 keyword-based search |
| `MEMORY_BM25_LANGUAGE` | `en` | BM25 language model |

## Offload Module (Context Compression)

The offload module prevents context window overflow by compressing conversation
history. It wraps the TencentDB-Agent-Memory library's offload algorithms into a
clean lifecycle integrated with the bot's `ChatService`.

### Architecture

The offload pipeline runs on every conversation turn:

```
  beforeTurn()         onToolCall()           afterTurn()
     │                    │                      │
  ┌──┴──┐             ┌──┴──┐                ┌──┴──┐
  │ L3  │             │Buffer│               │ L1  │
  │Comp.│             │Pairs │               │Flush│
  └─────┘             └─────┘                └─────┘
     │                                           │
     ▼                                           ▼
  History │                                  L1 entries
  compressed│                                 written to
  (mild/aggressive/     ◄──────               offload.jsonl
   emergency)

  (optional) L1.5: task boundary detection after L1 flush
  (optional) L2:    Mermaid MMD generation from entries
```

### Lifecycle (called from `ChatService.replyToUser()`)

| Method | When | What |
|---|---|---|
| `beforeTurn()` | Before LLM prompt build | L3-compress conversation history using mild/aggressive/emergency tiers. Optionally inject active MMD (if L2 enabled). |
| `onToolCall()` | During tool loop | Buffer tool call + result pairs for L1 summarization. |
| `afterTurn()` | After LLM reply | Flush L1 entries to JSONL (via LLM or degraded fallback). Run L1.5 judgment. Schedule L2 generation. |
| `close()` | Shutdown | Save all sessions, clear L2 and reclaim timers. |

### Compression Tiers

Compression is applied in order of severity (thresholds relative to `OFFLOAD_CONTEXT_WINDOW`):

| Tier | Trigger | Action |
|---|---|---|
| **Mild** | ≥ `mildOffloadRatio` (default 85%) | Replace tool result messages with L1 summaries. Requires L1 entries. |
| **Aggressive** | ≥ `aggressiveCompressRatio` (default 85%) | Delete oldest messages in rounds. |
| **Emergency** | ≥ `emergencyCompressRatio` (default 95%) | Delete messages down to `emergencyTargetRatio` (default 60%). |

### Why `OFFLOAD_TEMPERATURE` and `OFFLOAD_CONTEXT_WINDOW`?

These two configuration parameters are fundamental to how the offload module operates across all layers. Understanding why they exist helps you tune them correctly.

#### `OFFLOAD_TEMPERATURE` (default: `0.2`) — Determinism for offload LLM calls

Controls the LLM's creativity/randomness for offload tasks (L1 summarization, L1.5 task boundary judgment, L2 MMD generation).

| Chat LLM (e.g. `gpt-4o-mini`) | Offload LLM (e.g. `OFFLOAD_MODEL`) |
|---|---|
| Temperature ~0.7–1.0 | Temperature **0.2** (low) |
| Creative, varied responses | Deterministic, consistent output |
| User-facing conversation | Behind-the-scenes summarization |

> **Note:** The same model can serve both roles (by default `OFFLOAD_MODEL` falls back to `MODEL`).
> Temperature is applied per-API-call, so the model runs at 0.2 for offload tasks regardless of the chat temperature.

**Why so low?** Summarization and classification are deterministic tasks — you want consistent, factual summaries rather than creative variations. A higher temperature would produce different summaries for the same tool call on different runs, making the compressed history unpredictable.

- Default `0.2` matches the library's `PLUGIN_DEFAULTS` — battle-tested across many deployments.
- Only relevant when L1, L1.5, or L2 is enabled (requires a model for LLM calls).
- L3 compression alone does **not** use temperature (no LLM calls needed).

#### `OFFLOAD_CONTEXT_WINDOW` (default: `128000`) — The anchor for all compression thresholds

The model's total token capacity. All compression tier thresholds are calculated as **ratios of this value**:

```
mildThreshold       = contextWindow × OFFLOAD_MILD_RATIO           (default: 128K × 0.85 = 108.8K)
aggressiveThreshold = contextWindow × OFFLOAD_AGGRESSIVE_RATIO     (default: 128K × 0.85 = 108.8K)
emergencyThreshold  = contextWindow × OFFLOAD_EMERGENCY_RATIO      (default: 128K × 0.95 = 121.6K)
emergencyTarget     = contextWindow × OFFLOAD_EMERGENCY_TARGET     (default: 128K × 0.60 =  76.8K)
mmdMaxTokens        = contextWindow × OFFLOAD_MMD_MAX_TOKEN_RATIO  (default: 128K × 0.20 =  25.6K)
```

**Must match your model's actual context window.** Different models have drastically different limits:

| Model | Context Window | `OFFLOAD_CONTEXT_WINDOW` |
|---|---|---|
| GPT-4o-mini / GPT-4o | 128,000 tokens | `128000` ✅ (default) |
| Claude 3.5 Sonnet | 200,000 tokens | `200000` |
| Claude 3 Opus | 200,000 tokens | `200000` |
| Gemini 1.5 Pro | up to 2,097,152 tokens | `2097152` |
| DeepSeek-V2 | 128,000 tokens | `128000` |

- **If set too high** (> actual model limit): compression won't trigger before the API truncates your request (→ hard error from the API provider).
- **If set too low** (≪ actual model limit): compression triggers prematurely (→ unnecessary message deletion, context lost for no reason).
- **This does not affect the API's `max_tokens` parameter** — it only controls when the compressor activates.
- Default `128000` matches GPT-4o-mini, which is the default chat `MODEL`.
- Even with all optional features disabled (L1/L1.5/L2 = false), `OFFLOAD_CONTEXT_WINDOW` is **required** — L3 compression still needs it to calculate thresholds.
- `OFFLOAD_TEMPERATURE` is only plumbed to the `LocalLlmClient` (L1/L1.5/L2). L3 compression (which works autonomously) does **not** use temperature at all.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OFFLOAD_ENABLED` | `true` | Master switch — set to `false` to disable offload completely |
| `OFFLOAD_MODEL` | _(same as MODEL)_ | Separate LLM model for offload tasks (L1/L1.5/L2). Falls back to the main `MODEL` when not set. |
| `OFFLOAD_MODE` | `local` | Offload LLM execution mode (`local` or `backend`) |
| `OFFLOAD_TEMPERATURE` | `0.2` | LLM temperature for offload tasks |
| `OFFLOAD_FORCE_TRIGGER_THRESHOLD` | `4` | Force-trigger L1 summarization when pending tool pairs reaches this count |
| `OFFLOAD_CONTEXT_WINDOW` | `128000` | Model context window size (tokens) |
| `OFFLOAD_MAX_PAIRS_PER_BATCH` | `20` | Maximum tool pairs per offload batch |
| `OFFLOAD_L1_ENABLED` | `true` | Enable L1 tool pair summarization (requires a model — defaults to main `MODEL`) |
| `OFFLOAD_L15_ENABLED` | `true` | Enable L1.5 task boundary detection (requires a model) |
| `OFFLOAD_L2_ENABLED` | `true` | Enable L2 Mermaid MMD generation (requires a model) |
| `OFFLOAD_RETENTION_DAYS` | `0` | Auto-delete data older than N days (0 = disabled, minimum effective: 3) |
| `OFFLOAD_LOG_MAX_SIZE_MB` | `50` | Max total offload debug log size before reclaim truncates logs |
| `OFFLOAD_BACKEND_URL` | _(unset)_ | Optional backend offload service URL |
| `OFFLOAD_BACKEND_API_KEY` | _(unset)_ | Optional backend offload service API key |
| `OFFLOAD_BACKEND_TIMEOUT_MS` | `120000` | Backend offload service timeout |
| `OFFLOAD_USER_ID` | _(unset)_ | Optional backend offload persistence user id |

#### Compression Thresholds

| Variable | Default | Description |
|---|---|---|
| `OFFLOAD_MILD_RATIO` | `0.85` | Token utilisation ratio triggering mild compression |
| `OFFLOAD_AGGRESSIVE_RATIO` | `0.85` | Token utilisation ratio triggering aggressive compression |
| `OFFLOAD_EMERGENCY_RATIO` | `0.95` | Token utilisation ratio triggering emergency compression |
| `OFFLOAD_EMERGENCY_TARGET_RATIO` | `0.6` | Target utilisation after emergency compression |
| `OFFLOAD_AGGRESSIVE_DELETE_RATIO` | `0.4` | Fraction of oldest messages to delete per aggressive round |
| `OFFLOAD_MILD_SCAN_RATIO` | `0.7` | Fraction of messages scanned for mild compression candidates |
| `OFFLOAD_MMD_MAX_TOKEN_RATIO` | `0.2` | Max fraction of context window for MMD injection |

#### L2 Scheduling

| Variable | Default | Description |
|---|---|---|
| `OFFLOAD_L2_NULL_THRESHOLD` | `4` | Minimum null-score entries before L2 triggers |
| `OFFLOAD_L2_TIMEOUT_SECONDS` | `300` | Seconds since last L2 before a new check runs |

### Storage Layout

Offload data is co-located with TDAI memory under the configured data root:

```
data/
└── memory-tdai/
    └── offload/
        └── telegram-bot/
            ├── session-{uuid}/        # Per-session directory
            │   ├── offload-{id}.jsonl   # L1 entries (JSONL format)
            │   ├── state.json           # Serialized OffloadStateManager state
            │   └── mmds/                # MMD files (if L2 enabled)
            │       └── {ts}-{label}.mmd
            └── registry.json           # Session registry metadata
```

### Quick Start Example

Enable the context compression layer (no LLM model needed for L3 compression):

```env
OFFLOAD_ENABLED=true
OFFLOAD_CONTEXT_WINDOW=128000
OFFLOAD_AGGRESSIVE_RATIO=0.85
```

Enable L1 summarization (requires a model for LLM calls):

```env
OFFLOAD_ENABLED=true
OFFLOAD_MODEL=gpt-4o-mini
OFFLOAD_L1_ENABLED=true
```

### Running Tests

```bash
# All offload tests
bun test src/offload/

# Specific test categories
bun test src/offload/integration.test.ts   # E2E integration tests
bun test src/offload/compressor.test.ts    # Compression unit tests
bun test src/offload/index.test.ts         # Lifecycle unit tests

# Performance benchmark
bun scripts/offload-benchmark.ts
```

## Constraints

- OpenAI only in V1
- Text-only chat in V1
- No source edits inside `TencentDB-Agent-Memory/`
