# Wallet Telegram Commands Design

## Goal

Add Telegram commands for creating and managing one Solana wallet per request in the `agent` bot:

- `/wallets-gen` generates exactly one wallet, stores the full wallet data in SQLite, and replies only with the public address.
- `/wallets-now` lists the calling user's saved public addresses.
- `/wallets-privatekey <public-address>` starts a one-time code flow that reveals the private key only if the next message from that user matches the logged code.

The implementation uses `D:\Code\bot\spl-wallet-generator` as the reference for Solana wallet generation, but integrates the logic directly into the Bun/TypeScript bot instead of invoking the CLI.

## Architecture

### Wallet generation

Create `src/wallets/wallet-generator.ts` with a small function that generates one wallet using the same core algorithm as the reference project:

1. Generate a BIP39 mnemonic.
2. Convert the mnemonic to entropy.
3. Hash the entropy with SHA-256 to produce a 32-byte seed.
4. Create a Solana `Keypair` from the seed.
5. Return the public address, mnemonic, and base58-encoded secret key.

The function has no Telegram or database dependencies so it can be unit-tested directly.

### Wallet storage

Create `src/wallets/wallet-store.ts` as the SQLite boundary. It owns schema creation and exposes focused methods:

- `saveWallet(record)`
- `listPublicAddresses(telegramUserId)`
- `findWalletForUser(telegramUserId, publicAddress)`
- `close()`

The primary database path is `data/wallets/wallets.sqlite`, resolved from the existing runtime data root. A backup database is kept at `data/wallets/wallets-backup.sqlite`.

On `/wallets-gen`, the bot writes the new wallet to the primary database and then to the backup database. Reads use only the primary database. If the primary write fails, the command fails. If the backup write fails, the bot logs the error and warns the user that the wallet was created but backup failed.

### Private-key access

Create `src/wallets/private-key-access-service.ts` for short-lived private-key reveal requests. It keeps pending requests in memory, one per Telegram user, and logs issued codes to the daily verification-style log.

Flow:

1. User sends `/wallets-privatekey <public-address>`.
2. The service verifies the wallet belongs to that Telegram user.
3. The service logs a 6-digit code and remembers a pending request for that user.
4. Bot replies that a code was issued and the next message must be the code within 15 minutes.
5. If the next message is the exact code before expiration, the service returns the private key and clears the pending request.
6. If the next message is anything else, the pending request is canceled and the message is not sent to normal AI chat.
7. Pending requests expire after 15 minutes and are canceled.

This flow is separate from the existing `/verify` login flow so wallet secret access does not alter account verification state.

## Telegram behavior

### `/wallets-gen`

- Requires `ctx.from`; otherwise no action.
- Generates exactly one wallet.
- Stores the wallet in the primary and backup SQLite databases.
- Replies with the public address only.
- Does not send mnemonic or private key.

Example reply:

```text
Wallet created.
Public address: <address>
```

If backup storage fails after primary storage succeeds:

```text
Wallet created, but backup failed. Public address: <address>
```

### `/wallets-now`

- Lists only wallets owned by the calling Telegram user.
- Shows public addresses and no secrets.
- If none exist, replies `No wallets found.`

### `/wallets-privatekey <public-address>`

- Requires an address argument.
- If missing, replies with usage.
- If the wallet is not found for that user, replies `Wallet not found.`
- If found, logs a 6-digit code and asks the user to send it as the next message.
- The next message is intercepted before normal chat handling.
- Correct code within 15 minutes reveals the private key.
- Wrong code, expired code, or any unrelated message cancels the request.

## Data model

Primary and backup databases use the same table:

```sql
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  public_address TEXT NOT NULL UNIQUE,
  mnemonic TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallets_telegram_user_id
ON wallets (telegram_user_id);
```

`public_address` is globally unique. User-scoped lookups still include `telegram_user_id` so another user's wallet cannot be accessed by address.

## Error handling and security

- Never include mnemonic or private key in `/wallets-gen` or `/wallets-now` replies.
- `/wallets-privatekey` uses a generic `Wallet not found.` response for missing or not-owned wallets.
- A pending private-key request is consumed on success, wrong code, cancellation, or expiration.
- A non-code next message cancels the pending request and is not forwarded to the AI chat.
- Private-key codes are logged like verification codes, but are stored only in memory as hashes for matching.
- The SQLite store is the only persistent storage for wallet secrets; runtime logs must not include private keys or mnemonics.

## Testing

Add focused Bun tests for:

- Wallet generator returns a mnemonic, public address, and private key.
- Wallet store can initialize schema, save, list by user, and find only the owner wallet.
- `/wallets-gen` stores one wallet and replies only with the public address.
- `/wallets-now` lists only the calling user's public addresses.
- `/wallets-privatekey` validates missing, unknown, and owned address behavior.
- Pending private-key flow succeeds with the correct code.
- Wrong code cancels the pending request.
- Any unrelated next message cancels the pending request and bypasses normal chat.

## Scope exclusions

- No multi-wallet generation count for now.
- No export file command.
- No mnemonic reveal command.
- No encrypted-at-rest wallet storage in this iteration.
- No recovery reads from `wallets-backup.sqlite` unless a future task asks for restore behavior.
