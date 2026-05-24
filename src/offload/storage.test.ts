import { describe, expect, test } from "bun:test";
import {
  toOffloadSessionKey,
  resolveSessionKey,
  getAgentName,
  AGENT_NAME,
} from "./storage.ts";

describe("session key mapping", () => {
  test("toOffloadSessionKey maps tg:user format to agent format", () => {
    const result = toOffloadSessionKey("tg:user:12345");
    expect(result).toBe("agent:telegram-bot:12345");
  });

  test("toOffloadSessionKey handles string user IDs", () => {
    const result = toOffloadSessionKey("tg:user:abc-def");
    expect(result).toBe("agent:telegram-bot:abc-def");
  });

  test("toOffloadSessionKey handles keys without prefix", () => {
    const result = toOffloadSessionKey("bare-key");
    expect(result).toBe("agent:telegram-bot:bare-key");
  });

  test("toOffloadSessionKey handles keys with one colon", () => {
    const result = toOffloadSessionKey("custom:12345");
    expect(result).toBe("agent:telegram-bot:12345");
  });

  test("getAgentName returns telegram-bot", () => {
    expect(getAgentName()).toBe("telegram-bot");
  });

  test("AGENT_NAME is telegram-bot", () => {
    expect(AGENT_NAME).toBe("telegram-bot");
  });
});

describe("resolveSessionKey", () => {
  test("resolves a valid tg:user key", () => {
    const result = resolveSessionKey("tg:user:12345");
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("telegram-bot");
    expect(result!.sessionId).toBe("12345");
  });

  test("resolves a tg:user key with string ID", () => {
    const result = resolveSessionKey("tg:user:abc-123");
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("telegram-bot");
    expect(result!.sessionId).toBe("abc-123");
  });

  test("resolves bare keys by wrapping in agent:telegram-bot: prefix", () => {
    const result = resolveSessionKey("bare-key");
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("telegram-bot");
    expect(result!.sessionId).toBe("bare-key");
  });

  test("returns null for invalid key format", () => {
    const result = resolveSessionKey("");
    expect(result).toBeNull();
  });

  test("handles keys with multiple colons", () => {
    const result = resolveSessionKey("tg:user:abc:def:ghi");
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("telegram-bot");
    expect(result!.sessionId).toBe("abc:def:ghi");
  });

  test("toOffloadSessionKey is idempotent when called twice", () => {
    const once = toOffloadSessionKey("tg:user:42");
    const twice = toOffloadSessionKey(once);
    expect(twice).toBe("agent:telegram-bot:42");
  });

  test("toOffloadSessionKey handles empty string", () => {
    const result = toOffloadSessionKey("");
    expect(result).toBe("agent:telegram-bot:");
  });

  test("toOffloadSessionKey handles special characters in user ID", () => {
    const result = toOffloadSessionKey("tg:user:user@domain.com");
    expect(result).toBe("agent:telegram-bot:user@domain.com");
  });
});
