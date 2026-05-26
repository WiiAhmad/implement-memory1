// ═══════════════════════════════════════════════════════════════════════
//  [Step 37]  CONTEXT AGENT — Per-Turn Pipeline Orchestrator
//  ═══════════════════════════════════════════════════════════════════════
//  Owns the per-turn context pipeline for a single LLM conversation turn.
//  Called by ChatService for each user message.
//
//  Full Turn Flow (reply method):
//    1. tryCreateSkill    → Check for L4 /create-skill command
//    2. recall            → Retrieve relevant memories (TDAI engine)
//    3. prepareOffload    → Run offload beforeTurn (L3 compression)
//    4. build prompt      → Assemble system + user + history messages
//    5. LLM call          → Send to OpenAI with tool loop
//    6. offload afterTurn → Flush L1 entries, L1.5 judgment, schedule L2
//    7. capture           → Save turn to long-term memory (TDAI engine)
// ═══════════════════════════════════════════════════════════════════════

import type { Logger } from "../../TencentDB-Agent-Memory/src/core/types.ts";
import type { MemoryAdapter } from "../memory/types.ts";
import type { ChatClient, ChatMessage } from "../openai/chat-client.ts";
import { isTokenOverflowError } from "../offload/compressor.ts";
import type { OffloadService } from "../offload/index.ts";
import { PromptBuilder } from "../prompt/prompt-builder.ts";
import type { CoordinationService } from "../services/coordination.ts";
import type { ToolHandler } from "../tools/tool-handler.ts";

export interface ContextAgentOptions {
  memory: MemoryAdapter;
  chatClient: ChatClient;
  logger: Logger;
  promptBuilder?: PromptBuilder;
  toolHandler?: ToolHandler;
  offloadService?: OffloadService;
  coordination?: CoordinationService;
}

export interface ContextAgentReplyParams {
  telegramUserId: number;
  userKey: string;
  text: string;
  history: ChatMessage[];
}

export interface ContextAgentReplyResult {
  reply: string;
  updateHistory: boolean;
}

export class ContextAgent {
  private readonly promptBuilder: PromptBuilder;
  private readonly toolHandler?: ToolHandler;
  private readonly offloadService?: OffloadService;
  private readonly coordination?: CoordinationService;

  constructor(private readonly opts: ContextAgentOptions) {
    this.promptBuilder = opts.promptBuilder ?? new PromptBuilder();
    this.toolHandler = opts.toolHandler;
    this.offloadService = opts.offloadService;
    this.coordination = opts.coordination;
  }

  // ─── Step 37a: Main reply method (full turn pipeline) ────────────────
  //  Returns the bot's reply and whether to update conversation history.
  async reply(params: ContextAgentReplyParams): Promise<ContextAgentReplyResult> {
    const startedAt = Date.now();
    const { telegramUserId, userKey, text, history } = params;

    // ─── Step 37a-i: Check for L4 /create-skill command ─────────────
    //  If matched, handles the skill generation and returns immediately
    //  without going through the normal chat pipeline.
    const l4Result = await this.tryCreateSkill(userKey, text);
    if (l4Result) {
      this.opts.logger.info(`[timing] replyToUser L4 command total: ${Date.now() - startedAt}ms (user=${telegramUserId})`);
      return { reply: l4Result, updateHistory: false };
    }

    // ─── Step 37a-ii: Recall relevant memories ──────────────────────
    //  Fetches L1 memories and persona/scene context from TDAI engine.
    const recall = await this.recall(userKey, text);
    this.toolHandler?.resetCallCount(userKey);

    // ─── Step 37a-iii: Inject coordination context (Phase 5) ──────
    //  Inject persona/scene context into messages BEFORE offload compression
    //  so L3 preserves it rather than discarding it.
    const injectedMessages = this.coordination
      ? await this.injectCoordinationContext(recall, history)
      : history;

    // ─── Step 37a-iv: Offload beforeTurn (L3 compression) ──────────
    //  Compresses conversation history if above context window thresholds.
    const offloadMessages = await this.prepareOffloadMessages(userKey, text, injectedMessages);

    // ─── Step 37a-iv-b: Strip injected coordination context ─────────
    //  The coordination context was injected before L3 so the compressor
    //  preserves it, but it would duplicate with the prompt builder's
    //  formatting. Remove it now.
    const previousMessages = this.coordination
      ? this.stripCoordinationContext(offloadMessages)
      : offloadMessages;

    // ─── Step 37a-v: Build prompt ──────────────────────────────────
    const promptStartAt = Date.now();
    const prompt = this.promptBuilder.build({
      prependContext: recall.prependContext,
      appendSystemContext: recall.appendSystemContext,
      userText: text,
      previousMessages,
    });
    this.opts.logger.debug?.(`[timing] prompt.build: ${Date.now() - promptStartAt}ms`);

    // ─── Step 37a-vi: LLM call with tool loop ────────────────────────
    const offloadToolTasks: Promise<void>[] = [];
    const llmStartedAt = Date.now();
    let reply: string;
    try {
      reply = await this.opts.chatClient.reply({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        previousMessages: prompt.previousMessages,
        tools: this.toolHandler?.toolDefinitions,
        executeTool: this.toolHandler
          ? (name, args) => this.toolHandler!.executeTool(name, args, userKey)
          : undefined,
        onToolCallResult: this.offloadService
          ? (tc) => {
              const task = this.offloadService!.onToolCall({
                userKey, toolName: tc.toolName, toolCallId: tc.toolCallId,
                params: tc.params, result: tc.result,
              }).catch((err: unknown) => this.opts.logger.warn(`[offload] onToolCall error: ${this.formatError(err)}`));
              offloadToolTasks.push(task);
              void task;
            }
          : undefined,
        onStepFinish: this.offloadService
          ? async (messages) => {
              try { await this.offloadService!.onStepFinish(messages, userKey); }
              catch (err: unknown) { this.opts.logger.warn(`[offload] onStepFinish error: ${this.formatError(err)}`); }
            }
          : undefined,
      });
      this.opts.logger.info(`[timing] llm.reply: ${Date.now() - llmStartedAt}ms`);
    } catch (error) {
      await this.handleFailedReply(error, { userKey, userText: text, llmStartedAt, offloadToolTasks });
      throw error;
    }

    // ─── Step 37a-vii: Offload afterTurn ────────────────────────────
    //  Flushes L1 tool pairs, runs L1.5 task boundary judgment, schedules L2.
    await this.runOffloadAfterTurn(userKey, text, offloadToolTasks, false);

    // ─── Step 37a-viii: Capture turn to memory ─────────────────────
    //  Saves the completed user+assistant turn to TDAI long-term memory.
    await this.capture(userKey, text, reply);

    this.opts.logger.info(`[timing] replyToUser total: ${Date.now() - startedAt}ms (user=${telegramUserId})`);
    return { reply, updateHistory: true };
  }

  // ─── Step 37b: Try to handle L4 /create-skill command ───────────────
  private async tryCreateSkill(userKey: string, text: string): Promise<string | null> {
    const createSkill = this.offloadService?.createSkillFromCommand;
    if (typeof createSkill !== "function") return null;
    return await createSkill.call(this.offloadService, userKey, text);
  }

  // ─── Step 37c: Recall memories from TDAI engine ─────────────────────
  private async recall(userKey: string, text: string): Promise<{ prependContext: string; appendSystemContext: string }> {
    const recallStartedAt = Date.now();
    try {
      const recall = await this.opts.memory.recall(userKey, text);
      this.opts.logger.info(`[timing] recall: ${Date.now() - recallStartedAt}ms`);
      return {
        prependContext: recall.prependContext ?? "",
        appendSystemContext: recall.appendSystemContext ?? "",
      };
    } catch (error) {
      this.opts.logger.warn(`Memory recall failed (${Date.now() - recallStartedAt}ms): ${this.formatError(error)}`);
      return { prependContext: "", appendSystemContext: "" };
    }
  }

  // ─── Step 37d: Inject coordination context before compression (Phase 5) ─
  //  Injects persona/scene context into the message array BEFORE offload L3
  //  compression, so the compressor sees it as part of the message stream
  //  and preserves it rather than discarding it.
  //  After compression, the injected message is stripped so the prompt builder
  //  doesn't duplicate it (the prompt builder adds it back via recall context).
  private readonly injectSystemMsgLabel = "__coord_injected__";

  private async injectCoordinationContext(
    recall: { prependContext: string; appendSystemContext: string },
    history: ChatMessage[],
  ): Promise<ChatMessage[]> {
    if (!this.coordination) return history;
    const injectionContent = this.coordination.buildInjectionContext(recall);
    if (!injectionContent) return history;

    this.coordination.recordContextInjection();
    this.opts.logger.debug(`[coordination] injecting ${injectionContent.length} chars of scene/persona context before compression`);

    // Prepend the context as a system message so L3 sees it
    return [
      {
        role: "system" as const,
        content: `## ${this.injectSystemMsgLabel}
${injectionContent}`,
      },
      ...history,
    ];
  }

  /**
   * Strip the injected coordination system message from compressed messages
   * to avoid duplication — the prompt builder adds the context back via recall.
   */
  private stripCoordinationContext(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(
      (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(`## ${this.injectSystemMsgLabel}`)),
    );
  }

  // ─── Step 37e: Run offload beforeTurn (L3 compression) ─────────────
  private async prepareOffloadMessages(userKey: string, userText: string, history: ChatMessage[]): Promise<ChatMessage[]> {
    if (!this.offloadService) return history;
    const offloadStartedAt = Date.now();
    const messages = await this.offloadService.beforeTurn({ userKey, userText, previousMessages: history });
    this.opts.logger.info(`[timing] offload.beforeTurn: ${Date.now() - offloadStartedAt}ms`);
    return messages as ChatMessage[];
  }

  // ─── Step 37f: Handle LLM reply failure ─────────────────────────────
  private async handleFailedReply(error: unknown, params: {
    userKey: string; userText: string; llmStartedAt: number; offloadToolTasks: Promise<void>[];
  }): Promise<void> {
    const errorStr = this.formatError(error);
    this.opts.logger.info(`[timing] llm.reply FAILED: ${Date.now() - params.llmStartedAt}ms`);

    if (isTokenOverflowError(error)) {
      this.opts.logger.warn(`[chat] Token overflow detected: ${errorStr} - reporting to offload service`);
      this.offloadService?.reportTokenOverflow(params.userKey).catch((err: unknown) =>
        this.opts.logger.warn(`[offload] reportTokenOverflow failed: ${this.formatError(err)}`),
      );
    }

    if (params.offloadToolTasks.length > 0) {
      await this.runOffloadAfterTurn(params.userKey, params.userText, params.offloadToolTasks, true);
    }
  }

  // ─── Step 37g: Run offload afterTurn ────────────────────────────────
  private async runOffloadAfterTurn(userKey: string, userText: string, offloadToolTasks: Promise<void>[], afterFailedReply: boolean): Promise<void> {
    if (!this.offloadService) return;
    const afterTurnStartedAt = Date.now();
    await Promise.allSettled(offloadToolTasks);
    try {
      await this.offloadService.afterTurn({ userKey, userText });
    } catch (err) {
      const label = afterFailedReply ? "afterTurn after failed reply" : "afterTurn";
      this.opts.logger.warn(`[offload] ${label} failed: ${this.formatError(err)}`);
    }
    const timingLabel = afterFailedReply ? "offload.afterTurn after failed reply" : "offload.afterTurn";
    this.opts.logger.info(`[timing] ${timingLabel}: ${Date.now() - afterTurnStartedAt}ms`);
  }

  // ─── Step 37h: Capture turn to long-term memory ────────────────────
  private async capture(userKey: string, text: string, reply: string): Promise<void> {
    const captureStartedAt = Date.now();
    try { await this.opts.memory.capture(userKey, text, reply); }
    catch (err) { this.opts.logger.warn(`Memory capture failed: ${this.formatError(err)}`); }
    this.opts.logger.info(`[timing] memory.capture: ${Date.now() - captureStartedAt}ms`);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
