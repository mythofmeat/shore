import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";

export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: string;
  isToolResultOnly: boolean;
  isAutonomous: boolean;
}

export interface MemoryFileOp {
  path: string;
  content: string;
}

export interface CompactionResult {
  memoryFilesWritten: string[];
  conversationId: string;
  newConversationId: string;
  messageCount: number;
  compactedTurns: number;
  retainedCount: number;
  retainedTurns: number;
  markdownPaths: string[];
  toolRounds: number;
  toolsCalled: string[];
}

export interface DryRunResult {
  wouldWriteFiles: number;
  fileOpsPreview: MemoryFileOp[];
  messageCount: number;
  compactedTurns: number;
  retainedCount: number;
  retainedTurns: number;
  markdownPreview: string[];
  toolRounds: number;
  toolsCalled: string[];
}

export interface NoMemoryWritesResult {
  conversationId: string;
  messageCount: number;
  compactedTurns: number;
  toolRounds: number;
  toolsCalled: string[];
  rejectedPaths: string[];
  maxRoundsHit: boolean;
}

export type CompactionOutcome =
  | ({ kind: "compacted" } & CompactionResult)
  | ({ kind: "dry_run" } & DryRunResult)
  | ({ kind: "no_memory_writes" } & NoMemoryWritesResult);

export type CompactionErrorKind =
  | "llm"
  | "insufficient_messages"
  | "conversation"
  | "markdown_store"
  | "busy";

export class CompactionError extends Error {
  readonly kind: CompactionErrorKind;

  constructor(kind: CompactionErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "CompactionError";
  }

  static llm(detail: string): CompactionError {
    return new CompactionError("llm", `llm: ${detail}`);
  }

  static insufficientMessages(): CompactionError {
    return new CompactionError("insufficient_messages", "insufficient messages");
  }

  static markdownStore(detail: string): CompactionError {
    return new CompactionError("markdown_store", `markdown store: ${detail}`);
  }

  static conversationManager(detail: string): CompactionError {
    return new CompactionError("conversation", `conversation: ${detail}`);
  }

  static busy(character: string): CompactionError {
    return new CompactionError("busy", `Compaction already running for ${character}`);
  }
}

export interface CompactionLlm {
  buildInitialRequest(
    system: string,
    compactNowUser: WireMessage,
    chatRequest: SidecarRequest,
  ): SidecarRequest;

  generate(request: SidecarRequest): Promise<GenerateResponse>;
}

export interface ConversationManager {
  archiveAndRetain(
    conversationId: string,
    params: { keepLastN: number; activeContent: string },
  ): Promise<string>;
}

export interface ToolOutput {
  output: string;
  isError: boolean;
}

export interface CompactionTools {
  readonly workspaceDir: string;
  readonly configDir: string;

  dispatch(name: string, input: unknown): Promise<ToolOutput>;

  ensureWorkspaceGitRepo(workspaceDir: string, charName: string, reason: string): Promise<void>;

  gitCommitAll(workspaceDir: string, charName: string, message: string): Promise<boolean>;
}

export interface AppliedCompactionWrite {
  displayPath: string;
  resolvedPath: string;
  previousContent?: string;
  memoryIndexTarget: boolean;
}
