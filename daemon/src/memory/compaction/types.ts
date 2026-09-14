import type { WorkspaceEntry } from "../../tools/workspace_snapshot.ts";
import type { FrameSink } from "../../llm/stream";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";

export const COMPACTION_SUBAGENT = "compaction";

export function tagCompactionFrames(sink: FrameSink): FrameSink {
  return (message) => {
    switch (message.type) {
      case "stream_start":
      case "stream_chunk":
      case "stream_end":
      case "tool_call":
      case "tool_result":
        sink({ ...message, subagent: COMPACTION_SUBAGENT });
        return;
      default:
        sink(message);
    }
  };
}

export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: string;
  isToolResultOnly: boolean;
  isAutonomous: boolean;
  version?: string;
}

export interface CompactionCoverage {
  claim: string;
  unit: string;
  claimed: number;
  background: number;
  fresh: number;
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

export interface PausedCompactionResult {
  conversationId: string;
  checkpointId: string;
  messageCount: number;
  compactedTurns: number;
  toolRounds: number;
  toolsCalled: string[];
  reason: string;
  detail?: string;
  resumeAt?: string;
}

export interface RotatedResult {
  conversationId: string;
  dryRun: boolean;
  messageCount: number;
  archivedMessages: number;
  compactedTurns: number;
  retainedCount: number;
  retainedTurns: number;
}

export interface TruncatedCompactionResult {
  conversationId: string;
  messageCount: number;
  compactedTurns: number;
  toolRounds: number;
  toolsCalled: string[];
  truncatedTurns: number;
  partialWrites: string[];
}

export type CompactionOutcome =
  | ({ kind: "compacted" } & CompactionResult)
  | ({ kind: "dry_run" } & DryRunResult)
  | ({ kind: "rotated" } & RotatedResult)
  | ({ kind: "truncated" } & TruncatedCompactionResult)
  | ({ kind: "paused" } & PausedCompactionResult);

export type CompactionErrorKind =
  | "llm"
  | "insufficient_messages"
  | "conversation"
  | "markdown_store"
  | "busy";

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

export class CompactionPaused extends Error {
  readonly checkpointId: string;
  readonly reason: string;
  readonly resumeAt: string | undefined;

  constructor(checkpointId: string, reason: string, resumeAt?: string) {
    super(`compaction paused (${reason}, checkpoint=${checkpointId})`);
    this.name = "CompactionPaused";
    this.checkpointId = checkpointId;
    this.reason = reason;
    this.resumeAt = resumeAt;
  }
}

export interface CompactionLlm {
  buildInitialRequest(
    system: string,
    compactNowUser: WireMessage,
    chatRequest: SidecarRequest,
  ): SidecarRequest;

  generate(request: SidecarRequest): Promise<GenerateResponse>;
  run(
    request: SidecarRequest,
    tools: import("../../tools/execute.ts").ToolPhase,
    options?: import("../../llm/types.ts").ToolLoopOptions,
  ): Promise<GenerateResponse>;
}

export interface ConversationManager {
  archiveAndRetain(
    conversationId: string,
    params: {
      keepLastN: number;
      activeContent: string;
      operationId?: string;
      memoryBefore?: string;
      memoryAfter?: string;
      excluded?: boolean;
      note?: string;
      coverageClaim?: string;
    },
  ): Promise<string>;
}

export interface ToolOutput {
  output: string;
  isError: boolean;
}

export type CompactionWriteTracker = (
  name: string, input: unknown, write: () => Promise<ToolOutput>,
) => Promise<ToolOutput>;

export interface CompactionTools {
  readonly workspaceDir: string;

  dispatch(name: string, input: unknown, trackNestedWrite?: CompactionWriteTracker): Promise<ToolOutput>;

  deferEdit?(path: string): Promise<void>;

  ensureWorkspaceGitRepo(workspaceDir: string, charName: string, reason: string): Promise<void>;

  gitHead?(workspaceDir: string): Promise<string | undefined>;

  gitCommitAll(workspaceDir: string, charName: string, message: string): Promise<boolean>;
}

export interface AppliedCompactionWrite {
  displayPath: string;
  resolvedPath: string;
  previousState?: WorkspaceEntry | null;
  resultingState?: WorkspaceEntry | null;
  previousContent?: string;
  previousEncoding?: "base64";
  previousSymlink?: string;
  resultingContent?: string;
  deleted?: boolean;
}
