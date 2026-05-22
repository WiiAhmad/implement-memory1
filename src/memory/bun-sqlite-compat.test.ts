import { describe, expect, test } from "bun:test";
import { VectorStore } from "../../TencentDB-Agent-Memory/src/core/store/sqlite.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("VectorStore Bun SQLite compatibility", () => {
  test("initializes under Bun without node:sqlite", () => {
    const store = new VectorStore(":memory:", 1, noopLogger);

    try {
      const result = store.init({
        provider: "openai",
        model: "text-embedding-3-small",
      });

      expect(result).toEqual({ needsReindex: false, reason: undefined });
      expect(store.isDegraded()).toBe(false);
    } finally {
      store.close();
    }
  });
});
