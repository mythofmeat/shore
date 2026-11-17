export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: string;
  isToolResultOnly: boolean;
  isAutonomous: boolean;
  version?: string;
}

export interface CompactionOutcome {
  conversationId: string;
  dryRun: boolean;
  compactedTurns: number;
  retainedTurns: number;
}

export type CompactionErrorKind =
  | "llm"
  | "insufficient_messages"
  | "conversation"
  | "not_found"
  | "busy"
  | "wakes_thread";

export class CompactionError extends Error {
  readonly kind: CompactionErrorKind;

  constructor(kind: CompactionErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.name = "CompactionError";
  }

  static llm(detail: string, cause?: unknown): CompactionError {
    return new CompactionError("llm", `llm: ${detail}`, { cause });
  }

  static insufficientMessages(): CompactionError {
    return new CompactionError("insufficient_messages", "insufficient messages");
  }

  static conversationManager(detail: string): CompactionError {
    return new CompactionError("conversation", `conversation: ${detail}`);
  }

  static busy(character: string): CompactionError {
    return new CompactionError("busy", `Compaction already running for ${character}`);
  }

  static wakesThread(character: string, thread: string): CompactionError {
    return new CompactionError("wakes_thread", `"${thread}" is where Shore keeps the working from ${character}'s wakes. It is only a log, so it is never compacted`);
  }
}

export interface ConversationManager {
  archiveAndRetain(
    conversationId: string,
    params: {
      keepLastN: number;
      activeContent: string;
      excluded?: boolean;
      note?: string;
    },
  ): Promise<string>;
}
