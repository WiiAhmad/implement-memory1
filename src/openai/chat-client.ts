import OpenAI from "openai";

export interface ChatReplyParams {
  systemPrompt?: string;
  userPrompt: string;
}

export interface ChatClient {
  reply(params: ChatReplyParams): Promise<string>;
}

export class OpenAiChatClient implements ChatClient {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async reply(params: ChatReplyParams): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        ...(params.systemPrompt
          ? [{ role: "system" as const, content: params.systemPrompt }]
          : []),
        { role: "user" as const, content: params.userPrompt },
      ],
    });

    const message = response.choices[0]?.message;
    const text = typeof message?.content === "string" ? message.content.trim() : "";
    if (text) {
      return text;
    }

    const refusal = message?.refusal?.trim();
    if (refusal) {
      return refusal;
    }

    throw new Error("OpenAI returned an empty reply");
  }
}
