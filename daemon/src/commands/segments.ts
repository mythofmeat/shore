import { homeThreadOf } from "../engine/threads.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { readDurable, threadFile } from "../storage/files.ts";
import { join } from "node:path";

import {
  MAIN_THREAD,
  archiveKey,
  characterDataDir,
  threadDataDir,
} from "../config/dirs.ts";

import { HISTORY_DB_FILE, HistoryStore, type SegmentRecord } from "../engine/history_store.ts";
import { archiveAndRetain } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { resetActivePromptSnapshot } from "../memory/deferred_edits.ts";
import { withHistoryIndexLock } from "../memory/history_index.ts";
import { CommandError, internalError, invalidRequest, notFound } from "./errors.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { SegmentAction } from "../protocol/SegmentAction.ts";
import type { SegmentSummary } from "../protocol/SegmentSummary.ts";
type Args = OperationInput<"segments">;


export interface SegmentEngine {
  readonly characterName: string;
  readonly thread: string;
  reload(): Promise<void>;
}

export interface SegmentIndexMutationSink {
  progressFor?(character: string): { indexPath: string } | undefined;
  noteMutation?(character: string): void;
}

export interface ClearContext {
  dataDir: string;
  repoint?: (character: string) => Promise<void>;
  onComplete?: (character: string) => void;
  now?: () => string;
  newId?: () => string;
}

export async function segments(
  dataDir: string,
  character: string,
  thread: string,
  args: Args,
  historyIndex?: SegmentIndexMutationSink,
): Promise<OperationResult<"segments">> {
  const action = args.action ?? "list";
  const mutate = () =>
    runSegments(dataDir, character, thread, action, args, historyIndex);
  const indexPath =
    action === "list" || action === "show"
      ? undefined
      : historyIndex?.progressFor?.(character)?.indexPath;
  return indexPath === undefined
    ? mutate()
    : await withHistoryIndexLock(indexPath, async () => mutate());
}

function runSegments(
  dataDir: string,
  character: string,
  thread: string,
  action: SegmentAction,
  args: Args,
  historyIndex?: SegmentIndexMutationSink,
): OperationResult<"segments"> {
  const key = archiveKey(character, thread);
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    if (action === "list") {
      const records = store.entries(key).map(presentSegment);
      return { character, thread, segments: records, count: records.length };
    }

    const idx = segmentIndex(args["index"]);
    if (action === "show") {
      const record = store.entries(key).find((entry) => entry.idx === idx);
      if (record === undefined) throw notFound(missing(idx, character, thread));
      return {
        character,
        thread,
        segment: presentSegment(record),
        messages: store.readSegment(key, idx),
      };
    }

    let changed: boolean;
    switch (action) {
      case "exclude":
        changed = store.setExcluded(key, idx, true);
        break;
      case "include":
        changed = store.setExcluded(key, idx, false);
        break;
      case "label":
        changed = store.setLabel(key, idx, nullableText(args["value"], "label"));
        break;
      case "note":
        changed = store.setNote(key, idx, nullableText(args["value"], "note"));
        break;
      default:
        throw invalidRequest(`unknown segment action: ${String(action)}`);
    }
    if (!changed) throw notFound(missing(idx, character, thread));
    if (action === "exclude" || action === "include") {
      historyIndex?.noteMutation?.(character);
    }
    const record = store.entries(key).find((entry) => entry.idx === idx);
    if (record === undefined) throw notFound(missing(idx, character, thread));
    return { character, thread, action, segment: presentSegment(record) };
  } finally {
    store.close();
  }
}

export async function clear(
  engine: SegmentEngine,
  ctx: ClearContext,
  args: OperationInput<"clear">,
): Promise<OperationResult<"clear">> {
  return await withConversation(threadDataDir(ctx.dataDir, engine.characterName, engine.thread), "rewrite", async () => {
    const character = engine.characterName;
    const guard = tryBeginCompaction(ctx.dataDir, character);
    if (guard === undefined) {
      throw new CommandError("busy", `Compaction already running for ${character}`);
    }

    try {
      const characterDir = characterDataDir(ctx.dataDir, character);
      const conversationDir = threadDataDir(ctx.dataDir, character, engine.thread);
      let activeContent: string;
      try {
        activeContent = readDurable(threadFile(ctx.dataDir, character, engine.thread, "active.jsonl"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") activeContent = "";
        else throw error;
      }
      if (activeContent.trim() === "") throw invalidRequest("No messages to clear");

      const excluded = args["exclude"] === true;
      const note = nullableOptionalText(args["note"], "note");
      await archiveAndRetain(
        conversationDir,
        0,
        activeContent,
        ctx.now ?? (() => new Date().toISOString()),
        ctx.newId ?? (() => crypto.randomUUID()),
        `clear-${crypto.randomUUID()}`,
        {
          dbPath: join(ctx.dataDir, HISTORY_DB_FILE),
          archiveKey: archiveKey(character, engine.thread),
        },
        {
          ...(excluded ? { excluded: true } : {}),
          ...(note === undefined ? {} : { note }),
        },
      );

      try {
        await resetActivePromptSnapshot(characterDir, engine.thread);
        await engine.reload();
        if (engine.thread === await homeThreadOf(ctx.dataDir, character)) await ctx.repoint?.(character);
      } catch (error) {
        throw internalError(error instanceof Error ? error.message : String(error));
      }
      if (engine.thread === await homeThreadOf(ctx.dataDir, character)) ctx.onComplete?.(character);

      const store = HistoryStore.open(join(ctx.dataDir, HISTORY_DB_FILE));
      try {
        const record = store.entries(archiveKey(character, engine.thread)).at(-1);
        return {
          status: "clear",
          character,
          thread: engine.thread,
          message_count: record?.message_count ?? 0,
          segment: record === undefined ? null : presentSegment(record),
        };
      } finally {
        store.close();
      }
    } finally {
      guard.release();
    }
  });
}

function missing(idx: number, character: string, thread: string): string {
  const where = thread === MAIN_THREAD ? character : `${character} thread ${thread}`;
  return `segment ${String(idx)} not found for ${where}`;
}

function presentSegment(record: SegmentRecord): SegmentSummary {
  return {
    index: record.idx,
    first_message_at: record.first_message_at,
    last_message_at: record.last_message_at,
    compacted_at: record.compacted_at,
    message_count: record.message_count,
    excluded: record.excluded === true,
    label: record.label ?? null,
    note: record.note ?? null,
    memory_before: record.memory_before ?? null,
    memory_after: record.memory_after ?? null,
  };
}

function segmentIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest("segment index must be a non-negative integer");
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function nullableOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return nullableText(value, field) ?? undefined;
}
