// ═══════════════════════════════════════════════════════════════════════
//  [Step 15]  WALLET GENERATOR — Solana Keypair from BIP39 Mnemonic
//  ═══════════════════════════════════════════════════════════════════════
//  Generates a Solana wallet using BIP39 mnemonic entropy.
//  Flow: mnemonic → entropy → SHA-256 seed → Ed25519 keypair → Base58 keys
// ═══════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import * as bip39 from "bip39";
import bs58 from "bs58";
import type { GeneratedWallet } from "./types.ts";

// ─── Step 15a: Generate a complete Solana wallet ───────────────────────
//  1. Generate random BIP39 mnemonic (12 words by default)
//  2. Convert mnemonic to entropy bytes
//  3. Derive 256-bit seed via SHA-256 of entropy
//  4. Create Ed25519 keypair from seed
//  5. Encode private key as Base58, public key as Base58
export function generateSolanaWallet(): GeneratedWallet {
  const mnemonic = bip39.generateMnemonic();
  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const seed = createHash("sha256").update(entropy).digest();
  const keypair = Keypair.fromSeed(seed);

  return {
    mnemonic,
    privateKey: bs58.encode(keypair.secretKey),
    publicAddress: keypair.publicKey.toBase58(),
  };
}
