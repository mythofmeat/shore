import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { runCompactionPass, type CompactionRunDeps } from "../memory/compaction/run.ts";
import {
  CompactionError,
  type CompactionOutcome,
  type MemoryFileOp,
} from "../memory/compaction/types.ts";
import { CommandError, internalError, invalidRequest } from "./errors.ts";
import type { Args } from "./navigation.ts";

const PREVIEW_CHARS = 200;

export interface CompactEngine {
  readonly characterName: string;
  reload(): Promise<void>;
}

export interface CompactAutonomy {
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
  const dry = args["dry_run"];
  const restart = args["restart"];
  const keep = args["keep_turns"];
  return {
    dryRun: typeof dry === "boolean" ? dry : false,
    restart: typeof restart === "boolean" ? restart : false,
    keepTurnsOverride:
      typeof keep === "number" && Number.isSafeInteger(keep) && keep >= 0 ? keep : undefined,
  };
}

export async function compact(
  engine: CompactEngine,
  ctx: CompactContext,
  args: Args,
): Promise<unknown> {
  const { dryRun, restart, keepTurnsOverride } = parseCompactArgs(args);
  const character = engine.characterName;

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
        ...(keepTurnsOverride === undefined ? {} : { keepTurnsOverride }),
      },
    );
  } catch (e) {
    throw compactionError(e);
  }

  if (outcome === undefined) throw invalidRequest("No messages to compact");

  return await buildCompactionResponse(engine, ctx, character, outcome);
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
): Promise<unknown> {
  if (outcome.kind === "compacted") {
    console.info(
      `shore: compaction completed for ${character} ` +
        `(entries=${outcome.memoryFilesWritten.length}, message_count=${outcome.messageCount}, ` +
        `retained_count=${outcome.retainedCount})`,
    );
    await completeCompaction(engine, ctx, character, outcome.retainedTurns);
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
  }

  if (outcome.kind === "truncated") {
    console.warn(
      `shore: compaction for ${character} hit the token ceiling ` +
        `(${String(outcome.truncatedTurns)} truncated turn(s)) — conversation NOT archived`,
    );
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
  }

  if (outcome.kind === "paused") {
    console.warn(
      `shore: compaction paused for ${character} — conversation NOT archived ` +
        `(checkpoint=${outcome.checkpointId}, reason=${outcome.reason}, ` +
        `detail=${outcome.detail ?? "none"}, tool_rounds=${outcome.toolRounds})`,
    );
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
  }

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

function previewOf(op: MemoryFileOp): { path: string; content_preview: string } {
  return {
    path: op.path,
    content_preview: [...op.content].slice(0, PREVIEW_CHARS).join(""),
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
    );
  } catch (e) {
    console.warn(`shore: failed to apply deferred edits after compaction: ${String(e)}`);
  }

  try {
    await ctx.repoint?.(character, ctx.config);
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }

  ctx.autonomy.onCompactionComplete(character, retainedTurns);
}
