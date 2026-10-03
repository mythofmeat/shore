import { homeThreadOf } from "../engine/threads.ts";
import { threadDataDir } from "../config/dirs.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { shoreLog } from "../log.ts";

import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { runCompactionPass, type CompactionRunDeps } from "../memory/compaction/run.ts";
import {
  CompactionError,
  type CompactionOutcome,
  type MemoryFileOp,
} from "../memory/compaction/types.ts";
import { busy, CommandError, internalError, invalidRequest } from "./errors.ts";
import { cancelPass, lastPass, runningPass, watchPass, type EndedPass } from "../memory/compaction/activity.ts";
import type { FrameSink } from "../llm/stream.ts";
import type { CompactionPassEnd } from "../protocol/CompactionPassEnd.ts";
import type { CompactionTrigger } from "../protocol/CompactionTrigger.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
type Args = OperationInput<"compact">;

const PREVIEW_CHARS = 200;

export interface CompactEngine {
  readonly characterName: string;
  readonly thread?: string;
  reload(): Promise<void>;
}

interface CompactAutonomy {
  onCompactionComplete(character: string, turnCount: number): void;
}

export interface CompactContext {
  config: LoadedConfig;
  autonomy: CompactAutonomy;
  run: Omit<CompactionRunDeps, "config">;
  repoint?: (character: string, config: LoadedConfig) => Promise<void>;
}

export function parseCompactArgs(args: Args): {
  dryRun: boolean;
  restart: boolean;
  keepTurnsOverride: number | undefined;
} {
  return {
    dryRun: args.dry_run ?? false,
    restart: args.restart ?? false,
    keepTurnsOverride: args.keep_turns ?? undefined,
  };
}

export async function compact(
  engine: CompactEngine,
  ctx: CompactContext,
  args: Args,
): Promise<OperationResult<"compact">> {
  const { dryRun, restart, keepTurnsOverride } = parseCompactArgs(args);
  const character = engine.characterName;
  const live = runningPass(ctx.config.dirs.data, character);
  if (live !== undefined) {
    if (dryRun || restart || keepTurnsOverride !== undefined) {
      throw busy(
        `A ${TRIGGER_NAMES[live.trigger]} compaction is already running for ${character}; ` +
          "watch it with `shore compact --watch` or stop it with `shore compact --cancel`",
      );
    }
    ctx.run.emit?.({ type: "phase", rid: null, phase: `following the ${TRIGGER_NAMES[live.trigger]} compaction already running`, model: null });
    const ended = await watchPass(ctx.config.dirs.data, character, ctx.run.emit ?? (() => {}), ctx.run.signal);
    if (ended !== undefined) return watchedReport(ended);
  }

  return await withConversation(threadDataDir(ctx.config.dirs.data, character, engine.thread ?? "main"), "rewrite", async () => {
    let outcome: CompactionOutcome | undefined;
    try {
      outcome = await runCompactionPass(
        character,
        {
          ...ctx.run,
          config: ctx.config,
        },
        {
          dryRun,
          restart,
          trigger: "manual",
          ...(engine.thread === undefined ? {} : { thread: engine.thread }),
          ...(keepTurnsOverride === undefined ? {} : { keepTurnsOverride }),
        },
      );
    } catch (e) {
      throw compactionError(e);
    }

    if (outcome === undefined) throw invalidRequest("No messages to compact");

    return await buildCompactionResponse(engine, ctx, character, outcome);
  });
}

const TRIGGER_NAMES: Record<CompactionTrigger, string> = {
  manual: "manual",
  idle: "idle",
  turn: "chat-turn",
  deep_archive: "deep-archive",
};

function watchedReport(ended: EndedPass): OperationResult<"compact"> {
  if (ended.end.kind === "failed") throw internalError(ended.end.error);
  if (ended.end.outcome === undefined) throw invalidRequest("No messages to compact");
  return compactionReport(ended.character, ended.end.outcome);
}

export interface CompactionWatchContext {
  config: LoadedConfig;
  emit?: FrameSink | undefined;
  signal?: AbortSignal | undefined;
}

export async function watchCompaction(character: string, ctx: CompactionWatchContext): Promise<OperationResult<"compact_watch">> {
  const dataDir = ctx.config.dirs.data;
  const ended = await watchPass(dataDir, character, ctx.emit ?? (() => {}), ctx.signal);
  return ended === undefined
    ? { character, state: "idle", pass: passEnd(lastPass(dataDir, character)) }
    : { character, state: "finished", pass: passEnd(ended) };
}

export async function cancelCompaction(character: string, ctx: CompactionWatchContext): Promise<OperationResult<"compact_cancel">> {
  const dataDir = ctx.config.dirs.data;
  const ended = await cancelPass(dataDir, character, "Compaction cancelled on request");
  return ended === undefined
    ? { character, state: "idle", pass: passEnd(lastPass(dataDir, character)) }
    : { character, state: "cancelled", pass: passEnd(ended) };
}

export function passEnd(ended: EndedPass | undefined): CompactionPassEnd | null {
  if (ended === undefined) return null;
  const { end } = ended;
  return {
    thread: ended.thread,
    trigger: ended.trigger,
    started_at: toRfc3339(ended.startedAt),
    ended_at: toRfc3339(ended.endedAt),
    report: end.kind === "outcome" && end.outcome !== undefined ? compactionReport(ended.character, end.outcome) : null,
    error: end.kind === "failed" ? end.error : null,
  };
}

export function compactionError(e: unknown): CommandError {
  if (e instanceof CommandError) return e;
  if (e instanceof CompactionError) {
    if (e.kind === "busy") return new CommandError("busy", e.message);
    if (e.kind === "insufficient_messages") return invalidRequest(e.message);
    return internalError(e.message);
  }
  return internalError(e instanceof Error ? e.message : String(e));
}

export async function buildCompactionResponse(
  engine: CompactEngine,
  ctx: CompactContext,
  character: string,
  outcome: CompactionOutcome,
): Promise<OperationResult<"compact">> {
  if (outcome.kind === "compacted") {
    shoreLog.info(
      `shore: compaction completed for ${character} ` +
        `(entries=${outcome.memoryFilesWritten.length}, message_count=${outcome.messageCount}, ` +
        `retained_count=${outcome.retainedCount})`,
    );
    await completeCompaction(engine, ctx, character, outcome.retainedTurns);
  }

  if (outcome.kind === "rotated") {
    shoreLog.info(
      `shore: archive-only rotation for ${character} ` +
        `(dry_run=${String(outcome.dryRun)}, archived_messages=${String(outcome.archivedMessages)}, ` +
        `retained_turns=${String(outcome.retainedTurns)})`,
    );
    if (!outcome.dryRun) {
      await completeCompaction(engine, ctx, character, outcome.retainedTurns);
    }
  }

  if (outcome.kind === "truncated") {
    shoreLog.warn(
      `shore: compaction for ${character} hit the token ceiling ` +
        `(${String(outcome.truncatedTurns)} truncated turn(s)) — conversation NOT archived`,
    );
  }

  if (outcome.kind === "paused") {
    shoreLog.warn(
      `shore: compaction paused for ${character} — conversation NOT archived ` +
        `(checkpoint=${outcome.checkpointId}, reason=${outcome.reason}, ` +
        `detail=${outcome.detail ?? "none"}, tool_rounds=${outcome.toolRounds})`,
    );
  }

  return compactionReport(character, outcome);
}

export function compactionReport(character: string, outcome: CompactionOutcome): OperationResult<"compact"> {
  switch (outcome.kind) {
    case "compacted":
      return {
        status: "compacted",
        character,
        memory_files_written: outcome.memoryFilesWritten,
        message_count: outcome.messageCount,
        turn_count: outcome.compactedTurns,
        compacted_turns: outcome.compactedTurns,
        retained_count: outcome.retainedCount,
        retained_turns: outcome.retainedTurns,
        new_conversation_id: outcome.newConversationId,
        tool_rounds: outcome.toolRounds,
        tools_called: outcome.toolsCalled,
      };
    case "rotated":
      return {
        status: "rotated",
        character,
        dry_run: outcome.dryRun,
        memory_files_written: [],
        message_count: outcome.messageCount,
        archived_messages: outcome.archivedMessages,
        turn_count: outcome.compactedTurns,
        compacted_turns: outcome.compactedTurns,
        retained_count: outcome.retainedCount,
        retained_turns: outcome.retainedTurns,
      };
    case "truncated":
      return {
        status: "truncated",
        character,
        message_count: outcome.messageCount,
        turn_count: outcome.compactedTurns,
        compacted_turns: outcome.compactedTurns,
        tool_rounds: outcome.toolRounds,
        tools_called: outcome.toolsCalled,
        truncated_turns: outcome.truncatedTurns,
        partial_writes: outcome.partialWrites,
      };
    case "paused":
      return {
        status: "paused",
        character,
        checkpoint_id: outcome.checkpointId,
        message_count: outcome.messageCount,
        compacted_turns: outcome.compactedTurns,
        tool_rounds: outcome.toolRounds,
        tools_called: outcome.toolsCalled,
        reason: outcome.reason,
        detail: outcome.detail ?? null,
        resume_at: outcome.resumeAt ?? null,
      };
    case "dry_run":
      return {
        status: "dry_run",
        character,
        would_write_files: outcome.wouldWriteFiles,
        file_ops_preview: outcome.fileOpsPreview.map(previewOf),
        message_count: outcome.messageCount,
        turn_count: outcome.compactedTurns,
        compacted_turns: outcome.compactedTurns,
        retained_count: outcome.retainedCount,
        retained_turns: outcome.retainedTurns,
        tool_rounds: outcome.toolRounds,
        tools_called: outcome.toolsCalled,
      };
  }
}

function previewOf(op: MemoryFileOp): { path: string; content_preview: string } {
  return {
    path: op.path,
    content_preview: Array.from(op.content).slice(0, PREVIEW_CHARS).join(""),
  };
}

async function completeCompaction(
  engine: CompactEngine,
  ctx: CompactContext,
  character: string,
  retainedTurns: number,
): Promise<void> {
  try {
    await engine.reload();
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }

  try {
    await applyDeferredEdits(
      join(ctx.config.dirs.data, character),
      ctx.config.dirs.config,
      character,
      ctx.config.dirs.workspace,
      engine.thread,
    );
  } catch (e) {
    shoreLog.warn(`shore: failed to apply deferred edits after compaction: ${String(e)}`);
  }

  try {
    if (engine.thread === undefined || engine.thread === await homeThreadOf(ctx.config.dirs.data, character)) await ctx.repoint?.(character, ctx.config);
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }

  if (engine.thread === undefined || engine.thread === await homeThreadOf(ctx.config.dirs.data, character)) ctx.autonomy.onCompactionComplete(character, retainedTurns);
}
