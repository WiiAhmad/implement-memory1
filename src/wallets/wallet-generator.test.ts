import { describe, expect, test } from "bun:test";
import * as bip39 from "bip39";
import bs58 from "bs58";
import { generateSolanaWallet } from "./wallet-generator.ts";

describe("generateSolanaWallet", () => {
  test("returns a valid mnemonic, public address, and private key", () => {
    const wallet = generateSolanaWallet();

    expect(bip39.validateMnemonic(wallet.mnemonic)).toBe(true);
    expect(wallet.publicAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(wallet.privateKey).toBeString();
    expect(bs58.decode(wallet.privateKey).length).toBe(64);
  });

  test("generates different addresses on repeated calls", () => {
    const first = generateSolanaWallet();
    const second = generateSolanaWallet();

    expect(first.publicAddress).not.toBe(second.publicAddress);
  });
});
