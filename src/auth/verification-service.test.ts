import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { ensureRuntimeDirectories, resolveDataPaths } from "../utils/paths.ts";
import { JsonAuthStore } from "./auth-store.ts";
import type { TelegramIdentity } from "./types.ts";
import { VerificationService } from "./verification-service.ts";

const identity: TelegramIdentity = {
  telegramUserId: "42",
  username: "alice",
  firstName: "Alice",
};

describe("JsonAuthStore", () => {
  test("serializes concurrent updates so different users are not lost from JSON files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const store = new JsonAuthStore(paths);
      const pendingRecords = Array.from({ length: 25 }, (_, index) => ({
        telegramUserId: `${100 + index}`,
        username: `pending-${index}`,
        firstName: `Pending ${index}`,
        codeHash: `hash-${index}`,
        issuedAt: "2026-05-22T14:00:00.000Z",
        expiresAt: "2026-05-22T14:01:00.000Z",
        attemptCount: index,
      }));
      const verifiedRecords = pendingRecords.map((record, index) => ({
        telegramUserId: record.telegramUserId,
        username: record.username,
        firstName: record.firstName,
        verifiedAt: `2026-05-22T14:10:${index.toString().padStart(2, "0")}.000Z`,
        firstSeenAt: `2026-05-22T14:10:${index.toString().padStart(2, "0")}.000Z`,
        lastSeenAt: `2026-05-22T14:10:${index.toString().padStart(2, "0")}.000Z`,
      }));

      await Promise.all(pendingRecords.map((record) => store.savePending(record)));

      const pendingByUser = JSON.parse(
        await readFile(paths.pendingCodesFile, "utf8"),
      ) as Record<string, { telegramUserId: string }>;

      expect(Object.keys(pendingByUser).sort()).toEqual(
        pendingRecords.map((record) => record.telegramUserId).sort(),
      );

      await Promise.all(verifiedRecords.map((record) => store.saveVerified(record)));

      const verifiedByUser = JSON.parse(
        await readFile(paths.verifiedUsersFile, "utf8"),
      ) as Record<string, { telegramUserId: string }>;

      expect(Object.keys(verifiedByUser).sort()).toEqual(
        verifiedRecords.map((record) => record.telegramUserId).sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("VerificationService", () => {
  test("first contact issues a pending code, stores only the hash, and logs the plaintext code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const store = new JsonAuthStore(paths);
      const now = new Date("2026-05-22T14:00:00.000Z");
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        now: () => now,
        generateCode: () => "123456",
      });

      const result = await service.handleUnverifiedInput(identity, "hello");
      const pending = await store.getPending(identity.telegramUserId);
      const logText = await readFile(paths.verificationLogFile, "utf8");

      expect(result).toEqual({
        kind: "awaiting_code",
        expiresAt: "2026-05-22T14:15:00.000Z",
      });
      expect(pending).not.toBeNull();
      expect(pending?.telegramUserId).toBe(identity.telegramUserId);
      expect(pending?.username).toBe(identity.username);
      expect(pending?.firstName).toBe(identity.firstName);
      expect(pending?.codeHash).not.toBe("123456");
      expect(pending?.attemptCount).toBe(0);
      expect(logText).toContain('"telegramUserId":"42"');
      expect(logText).toContain('"username":"alice"');
      expect(logText).toContain('"code":"123456"');
      expect(JSON.stringify(result)).not.toContain("123456");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("matching code verifies the user once, deletes the pending record, and persists the verified user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const store = new JsonAuthStore(paths);
      const now = new Date("2026-05-22T14:10:00.000Z");
      const appendedLogs: string[] = [];
      const infoLogs: string[] = [];
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        logger: {
          info: (message) => {
            infoLogs.push(message);
          },
        },
        now: () => now,
        ttlMs: 60_000,
        generateCode: () => "654321",
        appendLog: (message) => {
          appendedLogs.push(message);
        },
      });

      await service.handleUnverifiedInput(identity, "hello");

      const result = await service.handleUnverifiedInput(identity, "654321");
      const pending = await store.getPending(identity.telegramUserId);
      const verified = await store.isVerified(identity.telegramUserId);
      const verifiedRecords = JSON.parse(
        await readFile(paths.verifiedUsersFile, "utf8"),
      ) as Record<string, { telegramUserId: string; verifiedAt: string }>;

      expect(result).toEqual({ kind: "verified" });
      expect(pending).toBeNull();
      expect(verified).toBe(true);
      expect(verifiedRecords[identity.telegramUserId]?.telegramUserId).toBe("42");
      expect(verifiedRecords[identity.telegramUserId]?.verifiedAt).toBe(
        "2026-05-22T14:10:00.000Z",
      );
      expect(appendedLogs).toHaveLength(2);
      expect(appendedLogs[1]).toContain('"telegramUserId":"42"');
      expect(appendedLogs[1]).toContain('"username":"alice"');
      expect(appendedLogs[1]).toContain('"firstName":"Alice"');
      expect(appendedLogs[1]).toContain('"code":"654321"');
      expect(appendedLogs[1]).toContain('"verifiedAt":"2026-05-22T14:10:00.000Z"');
      expect(infoLogs).toHaveLength(2);
      expect(infoLogs[0]).toContain('verification {"telegramUserId":"42"');
      expect(infoLogs[0]).toContain('"code":"654321"');
      expect(infoLogs[1]).toContain('verification {"telegramUserId":"42"');
      expect(infoLogs[1]).toContain('"code":"654321"');
      expect(infoLogs[1]).toContain('"verifiedAt":"2026-05-22T14:10:00.000Z"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expired codes are replaced with a fresh code instead of verifying with the stale one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const store = new JsonAuthStore(paths);
      const generatedCodes = ["111111", "222222"];
      let currentTime = new Date("2026-05-22T14:20:00.000Z");
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        now: () => currentTime,
        ttlMs: 60_000,
        generateCode: () => generatedCodes.shift() ?? "999999",
      });

      await service.handleUnverifiedInput(identity, "hello");
      const firstPending = await store.getPending(identity.telegramUserId);

      currentTime = new Date("2026-05-22T14:21:01.000Z");

      const result = await service.handleUnverifiedInput(identity, "111111");
      const secondPending = await store.getPending(identity.telegramUserId);
      const logText = await readFile(paths.verificationLogFile, "utf8");

      expect(result).toEqual({
        kind: "awaiting_code",
        expiresAt: "2026-05-22T14:22:01.000Z",
      });
      expect(firstPending).not.toBeNull();
      expect(secondPending).not.toBeNull();
      expect(secondPending?.codeHash).not.toBe(firstPending?.codeHash);
      expect(logText).toContain('"code":"111111"');
      expect(logText).toContain('"code":"222222"');
      expect(JSON.stringify(result)).not.toContain("222222");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed issuance logging leaves no active pending code behind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const store = new JsonAuthStore(paths);
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        generateCode: () => "777777",
        appendLog: () => {
          throw new Error("log write failed");
        },
      });

      await expect(service.handleUnverifiedInput(identity, "hello")).rejects.toThrow(
        "log write failed",
      );
      expect(await store.getPending(identity.telegramUserId)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed verification logging leaves the user unverified and keeps the pending code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-"));

    try {
      const paths = resolveDataPaths(root);
      await ensureRuntimeDirectories(paths);

      const store = new JsonAuthStore(paths);
      let appendCount = 0;
      const service = new VerificationService({
        store,
        verificationLogFile: paths.verificationLogFile,
        now: () => new Date("2026-05-22T14:30:00.000Z"),
        ttlMs: 60_000,
        generateCode: () => "888888",
        appendLog: () => {
          appendCount += 1;
          if (appendCount === 2) {
            throw new Error("log write failed");
          }
        },
      });

      await service.handleUnverifiedInput(identity, "hello");
      const pendingBeforeVerification = await store.getPending(identity.telegramUserId);

      await expect(service.handleUnverifiedInput(identity, "888888")).rejects.toThrow(
        "log write failed",
      );

      const pendingAfterVerification = await store.getPending(identity.telegramUserId);

      expect(await store.isVerified(identity.telegramUserId)).toBe(false);
      expect(pendingBeforeVerification).not.toBeNull();
      expect(pendingAfterVerification).not.toBeNull();
      expect(pendingAfterVerification?.codeHash).toBe(pendingBeforeVerification?.codeHash);
      expect(pendingAfterVerification?.attemptCount).toBe(pendingBeforeVerification?.attemptCount);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
