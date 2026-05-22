export interface MemoryRecall {
  prependContext?: string;
  appendSystemContext?: string;
}

export interface MemoryAdapter {
  recall(userKey: string, query: string): Promise<MemoryRecall>;
  capture(userKey: string, userText: string, assistantText: string): Promise<void>;
  close(): Promise<void>;
}
