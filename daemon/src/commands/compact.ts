import { homeThreadOf } from "../engine/threads.ts";
import { shoreLog } from "../log.ts";


import type { LoadedConfig } from "../config/loader.ts";
import { runCompactionPass, type CompactionRunDeps } from "../memory/compaction/run.ts";
import { CompactionError, type CompactionOutcome } from "../memory/compaction/types.ts";
import { CommandError, invalidRequest } from "./errors.ts";
import type { FrameSink } from "../llm/stream.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
type Args = OperationInput<"compact">;

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
  label?: CompactionRunDeps["generate"];
  repoint?: (character: string, config: LoadedConfig) => Promise<void>;
}

export async function compact(
  engine: CompactEngine,
  ctx: CompactContext,
  args: Args,
): Promise<OperationResult<"compact">> {
  const dryRun = args.dry_run ?? false;
  const keepTurnsOverride = args.keep_turns ?? undefined;
  const character = engine.characterName;

  let outcome: CompactionOutcome | undefined;
  try {
    outcome = await runCompactionPass(
      character,
      {
        config: ctx.config,
        afterArchive: async (thread) => {
          if (thread === await homeThreadOf(ctx.config.dirs.data, character)) await ctx.repoint?.(character, ctx.config);
        },
      },
      {
        dryRun,
        ...(engine.thread === undefined ? {} : { thread: engine.thread }),
        ...(keepTurnsOverride === undefined ? {} : { keepTurnsOverride }),
      },
    );
  } catch (e) {
    if (e instanceof CompactionError && e.kind === "busy") throw new CommandError("busy", e.message);
    if (e instanceof CompactionError && (e.kind === "insufficient_messages" || e.kind === "wakes_thread")) throw invalidRequest(e.message);
    throw e;
  }

  if (outcome === undefined) throw invalidRequest("No messages to compact");

  shoreLog.info(
    `shore: archived the conversation for ${character} ` +
      `(dry_run=${String(outcome.dryRun)}, compacted_turns=${String(outcome.compactedTurns)}, ` +
      `retained_turns=${String(outcome.retainedTurns)})`,
  );
  if (!outcome.dryRun) await completeCompaction(engine, ctx, character, outcome.retainedTurns);
  return {
    status: "rotated",
    character,
    dry_run: outcome.dryRun,
    memory_files_written: [],
    compacted_turns: outcome.compactedTurns,
    retained_turns: outcome.retainedTurns,
  };
}

export interface CompactionWatchContext {
  config: LoadedConfig;
  emit?: FrameSink | undefined;
  signal?: AbortSignal | undefined;
}

export function watchCompaction(character: string, _ctx: CompactionWatchContext): OperationResult<"compact_watch"> {
  return { character, state: "idle", pass: null };
}

export function cancelCompaction(character: string, _ctx: CompactionWatchContext): OperationResult<"compact_cancel"> {
  return { character, state: "idle", pass: null };
}

async function completeCompaction(
  engine: CompactEngine,
  ctx: CompactContext,
  character: string,
  retainedTurns: number,
): Promise<void> {
  if (engine.thread === undefined || engine.thread === await homeThreadOf(ctx.config.dirs.data, character)) ctx.autonomy.onCompactionComplete(character, retainedTurns);
}
