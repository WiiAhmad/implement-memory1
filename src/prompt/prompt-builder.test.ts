import { describe, expect, test } from "bun:test";
import { PromptBuilder } from "./prompt-builder.ts";

describe("PromptBuilder", () => {
  test("buildUserPrompt merges prependContext with userText using default separator", () => {
    const builder = new PromptBuilder();
    const result = builder.buildUserPrompt("Known fact: likes short answers.", "Hi");
    expect(result).toBe("Known fact: likes short answers.\n\nHi");
  });

  test("buildUserPrompt returns raw userText when prependContext is empty", () => {
    const builder = new PromptBuilder();
    expect(builder.buildUserPrompt(undefined, "Hello")).toBe("Hello");
    expect(builder.buildUserPrompt("", "Hello")).toBe("Hello");
  });

  test("buildUserPrompt uses custom separator from config", () => {
    const builder = new PromptBuilder({ contextSeparator: "\n---\n", trimUserPrompt: false });
    const result = builder.buildUserPrompt("Memory", "Hi");
    expect(result).toBe("Memory\n---\nHi");
  });

  test("build assembles full prompt result from context", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      prependContext: "<relevant-memories>...",
      appendSystemContext: "<user-persona>...",
      userText: "Hello",
      previousMessages: [
        { role: "user", content: "Hey" },
        { role: "assistant", content: "Hi!" },
      ],
    });

    expect(result).toEqual({
      systemPrompt: "<user-persona>...",
      userPrompt: "<relevant-memories>...\n\nHello",
      previousMessages: [
        { role: "user", content: "Hey" },
        { role: "assistant", content: "Hi!" },
      ],
    });
  });

  test("build omits systemPrompt when appendSystemContext is empty", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      prependContext: "",
      appendSystemContext: "",
      userText: "Hi",
    });
    expect(result.systemPrompt).toBeUndefined();
    expect(result.userPrompt).toBe("Hi");
    expect(result.previousMessages).toEqual([]);
  });

  test("build trims userPrompt by default", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      prependContext: "  context  ",
      userText: "  text  ",
    });
    // trim() only removes leading/trailing whitespace from the whole string,
    // so internal spaces around the separator are preserved.
    expect(result.userPrompt).toBe("context  \n\n  text");
  });

  test("build preserves whitespace when trimUserPrompt is false", () => {
    const builder = new PromptBuilder({ trimUserPrompt: false });
    const result = builder.build({
      prependContext: "  context  ",
      userText: "  text  ",
    });
    expect(result.userPrompt).toBe("  context  \n\n  text  ");
  });
});
