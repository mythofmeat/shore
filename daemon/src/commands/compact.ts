/**
 * The `compact` command: run a compaction pass, and report what it did.
 *
 * Ported from the `compact` half of `crates/daemon/src/commands/state/memory.rs`
 * — `parse_compact_args`, the two guards, `compaction_err` and
 * `build_compaction_response`/`complete_compaction` — pinned by
 * `tests/commands_fixtures/compact_parity.json`.
 *
 * The pass itself is not here. `memory/compaction/run.ts` is the assembly, and
 * it is shared with the idle trigger and the inline compaction a chat turn
 * schedules; what this module adds is the three things only a *command* needs:
 * arguments off the wire, a refusal with a code on it, and a rendering.
 *
 * # Three outcomes, and only one of them changes anything
 *
 * A pass ends archived, dry, or having written no memory. Only `compacted`
 * finishes anything: it reloads the engine, drains the deferred-edit queue and
 * tells autonomy the conversation moved. The other two answer and stop, because
 * nothing on disk changed and the next trigger will try again.
 *
 * The order inside the completion is the Rust's and it matters: reload, *then*
 * apply the deferred edits. The reload is what busts the cached prompt those
 * edits would otherwise be written behind. A failed reload gives up before
 * applying them; a failed *apply* only warns, because the compaction itself
 * succeeded and the conversation is sound.
 *
 * # `turn_count` and `compacted_turns` are the same number
 *
 * All three renderings carry both, with one value between them. That is the
 * Rust's, it is a client-compatibility duplicate rather than two facts, and it
 * is reproduced rather than tidied — a client reading the older name would
 * silently get `undefined`.
 */

import { join } from "node:path";

import type { LoadedConfig } from "../config/loader.ts";
import type { SidecarRequest } from "../llm/types.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { runCompactionPass, type CompactionRunDeps } from "../memory/compaction/run.ts";
import {
  CompactionError,
  type CompactionOutcome,
  type MemoryFileOp,
} from "../memory/compaction/types.ts";
import { CommandError, internalError, invalidRequest } from "./errors.ts";
import type { Args } from "./navigation.ts";

/** How much of a would-be memory write a dry run shows back. */
const PREVIEW_CHARS = 200;

/** The conversation this command compacts, and puts back in step afterwards. */
export interface CompactEngine {
  readonly characterName: string;
  reload(): Promise<void>;
}

/** Autonomy's half of the post-compaction bookkeeping. */
export interface CompactAutonomy {
  onCompactionComplete(character: string, turnCount: number): void;
}

/**
 * What the command needs beyond its arguments.
 *
 * `run` is the assembly's dependencies minus the two this supplies itself: the
 * character-effective config comes from the session, and `cachedRequest` is
 * read per call rather than held, because the thing holding it is a
 * conversation's last request and that moves every turn.
 */
export interface CompactContext {
  /** The character-effective config. `dirs.data` is the root the pass locks,
   *  reads and archives under — the Rust read it off the same place. */
  config: LoadedConfig;
  autonomy: CompactAutonomy;
  run: Omit<CompactionRunDeps, "config" | "cachedRequest">;
  /**
   * The body a chat turn last sent, when something is holding one.
   *
   * The Rust read `ctx.autonomy.cached_last_request(char_name)`. Nothing on
   * this side holds it yet — `notifyLastRequest` is a surface `handler/` calls
   * and `main.rs` wires — so an absent getter takes the same branch a cold
   * daemon took: rebuild the chat-shape request from disk. Same wire shape,
   * colder prefix.
   */
  cachedRequest?: (character: string) => SidecarRequest | undefined;
}

/**
 * The two arguments, and what each accepts.
 *
 * Both parses are strict in the Rust's way — `as_bool` and `as_u64` reject
 * rather than coerce — and both fold a rejection into the absent case, so
 * `{"keep_turns": "3"}` compacts with the configured retention and says
 * nothing about the string. Reproduced rather than improved: a client that has
 * been sending the wrong type has been getting the default for as long as it
 * has been sending it, and starting to refuse is the change, not the fix.
 *
 * One boundary cannot be reproduced and is not worth pretending about. Rust
 * read a `u64`, JSON on this side is a double, and above 2^53 the two stop
 * agreeing about which integers exist. `keep_turns` is a count of conversation
 * turns to retain, so the safe-integer ceiling is the honest test.
 */
export function parseCompactArgs(args: Args): {
  dryRun: boolean;
  keepTurnsOverride: number | undefined;
} {
  const dry = args["dry_run"];
  const keep = args["keep_turns"];
  return {
    dryRun: typeof dry === "boolean" ? dry : false,
    keepTurnsOverride:
      typeof keep === "number" && Number.isSafeInteger(keep) && keep >= 0 ? keep : undefined,
  };
}

/**
 * Run a pass on the current character's conversation.
 *
 * The character is the session's; there is no name argument, so this always
 * compacts whoever is talking.
 */
export async function compact(
  engine: CompactEngine,
  ctx: CompactContext,
  args: Args,
): Promise<unknown> {
  const { dryRun, keepTurnsOverride } = parseCompactArgs(args);
  const character = engine.characterName;

  let outcome: CompactionOutcome | undefined;
  try {
    outcome = await runCompactionPass(
      character,
      {
        ...ctx.run,
        config: ctx.config,
        ...cachedRequestFor(ctx, character),
      },
      {
        dryRun,
        ...(keepTurnsOverride === undefined ? {} : { keepTurnsOverride }),
      },
    );
  } catch (e) {
    throw compactionError(e);
  }

  // The pass returns nothing for a conversation with nothing in it. The Rust
  // checked that itself, between claiming the slot and assembling anything —
  // which is why a busy refusal beats this one, and why that ordering is a
  // recorded case rather than a comment.
  if (outcome === undefined) throw invalidRequest("No messages to compact");

  return await buildCompactionResponse(engine, ctx, character, outcome);
}

/** The cached request, spread so an absent getter passes no key at all. */
function cachedRequestFor(
  ctx: CompactContext,
  character: string,
): { cachedRequest?: SidecarRequest } {
  const cached = ctx.cachedRequest?.(character);
  return cached === undefined ? {} : { cachedRequest: cached };
}

/**
 * A pass failure as the client sees it.
 *
 * `compaction_err`'s mapping, plus the guard. Only `insufficient_messages` is
 * the caller's fault — it means the conversation is shorter than the pass
 * needs — so it is the one that is `invalid_request`; the rest are the daemon
 * failing to do something it agreed to do. Anything that is not a
 * {@link CompactionError} reaches here from underneath the assembly (a
 * provider's own error, a missing key) and keeps its message, which is what the
 * Rust's `map_err(|e| (InternalError, e.to_string()))` produced for the same
 * failures.
 */
export function compactionError(e: unknown): CommandError {
  if (e instanceof CommandError) return e;
  if (e instanceof CompactionError) {
    if (e.kind === "busy") return new CommandError("busy", e.message);
    if (e.kind === "insufficient_messages") return invalidRequest(e.message);
    return internalError(e.message);
  }
  return internalError(e instanceof Error ? e.message : String(e));
}

// ── the three renderings ────────────────────────────────────────────────

/**
 * One outcome, rendered — and, for `compacted`, finished.
 *
 * Exported because it is what the parity fixture drove: the Rust generator
 * called `build_compaction_response` with constructed outcomes rather than
 * running eight real compaction passes, and the replay does the same. `compact`
 * reaches it the same way, so it is the real path either way.
 */
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

  if (outcome.kind === "no_memory_writes") {
    console.warn(
      `shore: compaction produced no memory writes for ${character} — conversation NOT archived ` +
        `(tool_rounds=${outcome.toolRounds}, rejected=${outcome.rejectedPaths.length}, ` +
        `max_rounds_hit=${outcome.maxRoundsHit})`,
    );
    return {
      status: "no_memory_writes",
      character,
      message_count: outcome.messageCount,
      turn_count: outcome.compactedTurns,
      compacted_turns: outcome.compactedTurns,
      tool_rounds: outcome.toolRounds,
      tools_called: outcome.toolsCalled,
      rejected_paths: outcome.rejectedPaths,
      max_rounds_hit: outcome.maxRoundsHit,
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

/**
 * The first 200 *characters* of what would have been written.
 *
 * `chars().take(200)` in the Rust counts Unicode scalar values. `slice(0, 200)`
 * here would count UTF-16 code units, and the two stop agreeing the moment an
 * astral-plane character appears — 200 emoji in the Rust, 100 in the obvious
 * TypeScript. Spreading the string iterates by code point, which is the Rust's
 * unit, so the fixture's 250-emoji preview comes back the same length on both
 * sides.
 */
function previewOf(op: MemoryFileOp): { path: string; content_preview: string } {
  return {
    path: op.path,
    content_preview: [...op.content].slice(0, PREVIEW_CHARS).join(""),
  };
}

/**
 * Put the world back in step with what the pass wrote.
 *
 * Reload, apply, notify — the same three the inline path in `handler/turn.ts`
 * runs, in the same order and with the same tolerances. The one difference is
 * the reload: inline it is a warning and a return, because a chat turn has
 * already answered the user; here it is the command's failure, because the
 * command's whole answer is what the pass did.
 */
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

  ctx.autonomy.onCompactionComplete(character, retainedTurns);
}
