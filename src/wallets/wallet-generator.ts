import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import * as bip39 from "bip39";
import bs58 from "bs58";
import type { GeneratedWallet } from "./types.ts";

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
