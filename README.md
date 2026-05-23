# agent

## Setup

```bash
bun install
cp .env.example .env
```

Running `bun install` at the repo root also installs dependencies in `TencentDB-Agent-Memory/`.

Set all OpenAI and Telegram values in `.env` before starting the bot.

## Run

```bash
bun run index.ts
```

## Verification flow

1. A new Telegram user sends any text message.
2. The bot writes a one-time verification code to `data/logs/<yyyy-mm-dd>-verification.log`.
3. The user sends that code back in Telegram.
4. After a successful match, the user stays verified for future chats.

## Memory storage

- Auth files: `data/auth/pending-codes.json`, `data/auth/verified-users.json`
- Verification log: `data/logs/<yyyy-mm-dd>-verification.log`
- TencentDB memory: `data/memory-tdai/`

## Constraints

- OpenAI only in V1
- Text-only chat in V1
- No source edits inside `TencentDB-Agent-Memory/`
