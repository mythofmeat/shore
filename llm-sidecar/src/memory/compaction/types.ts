/**
 * The vocabulary of a compaction pass: what goes in, what comes out, and the
 * two dependencies the manager drives rather than owns.
 *
 * Ported from `crates/daemon/src/memory/compaction/types.rs`, pinned by
 * `tests/memory_fixtures/compaction_parity.json`.
 */

import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";

/**
 * A message from a conversation, as compaction sees it.
 *
 * Flattened from the stored `Message` by the caller — compaction never reads
 * `active.jsonl` itself, it is handed the parse. The two booleans are the
 * whole of what the split logic looks at beyond `role`.
 */
export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: string;
  /**
   * True when a user message's content blocks are *all* tool results — a
   * tool-loop intermediate rather than a real user turn. The turn split walks
   * past these so a loop is never cut in half.
   */
  isToolResultOnly: boolean;
  /**
   * True when the message was sent autonomously (a heartbeat's
   * `<sendMessage>`). Deep-idle archiving keeps a trailing run of these
   * visible.
   */
  isAutonomous: boolean;
}

/** A memory file operation: what a dry run would have written. */
export interface MemoryFileOp {
  path: string;
  content: string;
}

/** Result of an actual compaction. */
export interface CompactionResult {
  memoryFilesWritten: string[];
  conversationId: string;
  newConversationId: string;
  messageCount: number;
  compactedTurns: number;
  retainedCount: number;
  retainedTurns: number;
  /** Paths of markdown files written during compaction. */
  markdownPaths: string[];
  /** Number of tool-use rounds the compaction LLM ran. */
  toolRounds: number;
  /**
   * Names of tools the compaction LLM called, in order. Useful for forensics
   * when the model used read-only tools alongside writes.
   */
  toolsCalled: string[];
}

/** Result of a dry-run compaction. */
export interface DryRunResult {
  wouldWriteFiles: number;
  fileOpsPreview: MemoryFileOp[];
  messageCount: number;
  compactedTurns: number;
  retainedCount: number;
  retainedTurns: number;
  /** Paths of markdown files that would be written. */
  markdownPreview: string[];
  /**
   * Tool-use rounds the compaction LLM ran during the dry pass. Writes are
   * blocked but read-only tool calls still count.
   */
  toolRounds: number;
  toolsCalled: string[];
}

/** Diagnostics for a pass that produced no allowed memory writes. */
export interface NoMemoryWritesResult {
  conversationId: string;
  /** Messages that would have been archived if the pass had produced writes. */
  messageCount: number;
  compactedTurns: number;
  toolRounds: number;
  toolsCalled: string[];
  /**
   * Paths the model tried to write and the compaction path filter rejected
   * (SOUL-adjacent daemon artifacts, anything outside `memory/`). Empty when
   * the model wrote nothing at all.
   */
  rejectedPaths: string[];
  /**
   * True if the loop ended because it hit the per-model `max_tool_iterations`
   * cap rather than the model stopping cleanly. Always false when the cap is
   * unlimited, which is the default.
   */
  maxRoundsHit: boolean;
}

/**
 * How a pass ended.
 *
 * `no_memory_writes` is the one that carries a rule rather than a report: the
 * compaction LLM ran and produced zero allowed memory writes, so the active
 * conversation was **not** archived and the caller should leave the transcript
 * in place and retry on the next trigger. It exists to make it impossible to
 * silently archive without writing memory — the failure mode the tool-loop
 * redesign was for.
 */
export type CompactionOutcome =
  | ({ kind: "compacted" } & CompactionResult)
  | ({ kind: "dry_run" } & DryRunResult)
  | ({ kind: "no_memory_writes" } & NoMemoryWritesResult);

/**
 * Which failure this is.
 *
 * Four of the Rust enum's five variants, plus one it did not have. The missing
 * fifth is `Parse`, which had no constructor left: `parse_compaction_response`
 * was the only thing that ever built one, and it went with the rest of the XML
 * parser (see `prompts.ts`). The one remaining mention is a match arm in the
 * command surface, which is a reader, not a writer.
 *
 * The addition is `busy`. The Rust raised the already-running refusal in two
 * places with two different types — `commands/state/memory.rs` made it
 * `ErrorCode::Busy` and `memory/compaction/background.rs` made it an
 * `io::ErrorKind::WouldBlock` — because the guard was taken separately in each.
 * Flattening the two assemblies into one (`compaction/run.ts`) leaves one
 * raiser, and it has to carry enough for `shore compact` to still answer
 * `busy` rather than `internal_error`. Hence a kind of its own, and a message
 * with no prefix on it, which is what the command reported.
 */
export type CompactionErrorKind =
  | "llm"
  | "insufficient_messages"
  | "conversation"
  | "markdown_store"
  | "busy";

/**
 * A compaction failure.
 *
 * `message` reproduces the Rust `Display`, prefix included, because the
 * strings reach an operator through the command surface. `kind` is what the
 * handler branches on.
 */
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

  /** The archive or the retained write failed. `conversation: ` in the Rust's
   *  `Display`, which is what reaches an operator through `shore compact`. */
  static conversationManager(detail: string): CompactionError {
    return new CompactionError("conversation", `conversation: ${detail}`);
  }

  /** A pass is already running against this character's data root. No prefix:
   *  this string is the command's `busy` message verbatim. */
  static busy(character: string): CompactionError {
    return new CompactionError("busy", `Compaction already running for ${character}`);
  }
}

/**
 * The LLM half of a compaction pass.
 *
 * The manager drives the tool loop itself — it owns the path filter, the
 * rollback list and the "no writes, no archive" guard — so this is only the
 * two things the manager cannot do:
 *
 * 1. {@link buildInitialRequest} produces the first request for a pass by
 *    extending a chat-shape request with the compaction tail.
 * 2. {@link generate} runs a single round against an already-built request.
 *
 * `chatRequest` carries chat's `(system, tools, messages)`, either from the
 * cached `last_request` (warm) or rebuilt from disk (cold). Either way the
 * wire shape is what chat's next turn would have sent. The implementation
 * rebuilds it against the compaction model and appends the "compact now" user
 * message plus an inline `role:"system"` entry carrying the instruction at a
 * fixed slot — the only shape that stays byte-stable across the tool loop, and
 * so the only one that keeps chat's cache prefix extending cleanly.
 */
export interface CompactionLlm {
  buildInitialRequest(
    system: string,
    compactNowUser: WireMessage,
    chatRequest: SidecarRequest,
  ): SidecarRequest;

  generate(request: SidecarRequest): Promise<GenerateResponse>;
}

/**
 * Conversation lifecycle: archive old messages, retain recent ones.
 *
 * `memory/compaction_writer.ts`'s `ConversationArchiver` is the production
 * implementation; the Rust named the same seam `ConversationManager`.
 */
export interface ConversationManager {
  archiveAndRetain(
    conversationId: string,
    params: { keepLastN: number; activeContent: string },
  ): Promise<string>;
}

/** What a single tool call returned. */
export interface ToolOutput {
  output: string;
  isError: boolean;
}

/**
 * The slice of the tool layer a compaction pass reaches for.
 *
 * The Rust took a `&dyn ToolContext` and called two free functions on it —
 * `tools::dispatch_tool` and `content_util::dispatch_result_to_output`, always
 * as a pair, always in that order — plus two git helpers from
 * `tools::workspace`. Compaction never used the rest of `ToolContext`, and it
 * cannot: it hands the model's input straight through and only inspects the
 * result's success. Narrowing the dependency to what is actually reached keeps
 * a 4,700-line module out of this one's type surface, and folds the
 * dispatch/render pair into the single call it always was.
 */
export interface CompactionTools {
  /** `tool_ctx.workspace_dir()`. */
  readonly workspaceDir: string;
  /**
   * `tool_ctx.config_dir()`. Empty marks a context that does not queue
   * prompt-visible edits itself, which is what
   * {@link import("./manager").queueMemoryIndexRefresh} falls back for.
   */
  readonly configDir: string;

  /** Run one tool call and render its result the way the model will see it. */
  dispatch(name: string, input: unknown): Promise<ToolOutput>;

  /**
   * Make sure the workspace is a git repository before a live pass starts, so
   * the model's own `git` commits land somewhere. Best-effort in the Rust and
   * best-effort here: it never throws.
   */
  ensureWorkspaceGitRepo(workspaceDir: string, charName: string, reason: string): Promise<void>;

  /** Commit everything in the workspace. Resolves false when there was nothing to commit. */
  gitCommitAll(workspaceDir: string, charName: string, message: string): Promise<boolean>;
}

/**
 * A workspace memory write applied during the tool loop.
 *
 * Kept on the pass's rollback list so a downstream archive failure can restore
 * the previous content, or delete the file when there was none.
 */
export interface AppliedCompactionWrite {
  /** The path the model passed to `edit`, in display form. */
  displayPath: string;
  /** Where that resolved to on disk. */
  resolvedPath: string;
  /** Content captured before the write; absent when the file did not exist. */
  previousContent?: string;
  /**
   * True when the target was the workspace-root `MEMORY.md` (or a spelling
   * that normalizes to it). Diagnostic only — the dispatch layer's
   * `defer_edit` hook is what actually queues the prompt refresh.
   */
  memoryIndexTarget: boolean;
}
