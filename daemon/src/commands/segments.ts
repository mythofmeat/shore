import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore, type SegmentRecord } from "../engine/history_store.ts";
import { archiveAndRetain } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { withHistoryIndexLock } from "../memory/history_index.ts";
import { CommandError, internalError, invalidRequest, notFound } from "./errors.ts";
import type { Args } from "./navigation.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";

export interface SegmentEngine {
  readonly characterName: string;
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
  args: Args,
  historyIndex?: SegmentIndexMutationSink,
): Promise<unknown> {
  const action = typeof args["action"] === "string" ? args["action"] : "list";
  const mutate = () => runSegments(dataDir, character, action, args, historyIndex);
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
  action: string,
  args: Args,
  historyIndex?: SegmentIndexMutationSink,
): unknown {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    if (action === "list") {
      const records = store.entries(character).map(presentSegment);
      return { character, segments: records, count: records.length };
    }

    const idx = segmentIndex(args["index"]);
    if (action === "show") {
      const record = store.entries(character).find((entry) => entry.idx === idx);
      if (record === undefined) throw notFound(`segment ${String(idx)} not found for ${character}`);
      return {
        character,
        segment: presentSegment(record),
        messages: store.readSegment(character, idx),
      };
    }

    let changed: boolean;
    switch (action) {
      case "exclude":
        changed = store.setExcluded(character, idx, true);
        break;
      case "include":
        changed = store.setExcluded(character, idx, false);
        break;
      case "label":
        changed = store.setLabel(character, idx, nullableText(args["value"], "label"));
        break;
      case "note":
        changed = store.setNote(character, idx, nullableText(args["value"], "note"));
        break;
      default:
        throw invalidRequest(`unknown segment action: ${action}`);
    }
    if (!changed) throw notFound(`segment ${String(idx)} not found for ${character}`);
    if (action === "exclude" || action === "include") {
      historyIndex?.noteMutation?.(character);
    }
    const record = store.entries(character).find((entry) => entry.idx === idx);
    if (record === undefined) throw notFound(`segment ${String(idx)} not found for ${character}`);
    return { character, action, segment: presentSegment(record) };
  } finally {
    store.close();
  }
}

export async function clear(
  engine: SegmentEngine,
  ctx: ClearContext,
  args: Args,
): Promise<unknown> {
  const character = engine.characterName;
  const guard = tryBeginCompaction(ctx.dataDir, character);
  if (guard === undefined) {
    throw new CommandError("busy", `Compaction already running for ${character}`);
  }

  try {
    const characterDir = join(ctx.dataDir, character);
    let activeContent: string;
    try {
      activeContent = await readFile(join(characterDir, ACTIVE_JSONL_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") activeContent = "";
      else throw error;
    }
    if (activeContent.trim() === "") throw invalidRequest("No messages to clear");

    const excluded = args["exclude"] === true;
    const note = nullableOptionalText(args["note"], "note");
    await archiveAndRetain(
      characterDir,
      0,
      activeContent,
      ctx.now ?? (() => new Date().toISOString()),
      ctx.newId ?? (() => crypto.randomUUID()),
      `clear-${crypto.randomUUID()}`,
      { dbPath: join(ctx.dataDir, HISTORY_DB_FILE), character },
      {
        ...(excluded ? { excluded: true } : {}),
        ...(note === undefined ? {} : { note }),
      },
    );

    try {
      await engine.reload();
      await ctx.repoint?.(character);
    } catch (error) {
      throw internalError(error instanceof Error ? error.message : String(error));
    }
    ctx.onComplete?.(character);

    const store = HistoryStore.open(join(ctx.dataDir, HISTORY_DB_FILE));
    try {
      const record = store.entries(character).at(-1);
      return {
        status: "clear",
        character,
        message_count: record?.message_count ?? 0,
        segment: record === undefined ? null : presentSegment(record),
      };
    } finally {
      store.close();
    }
  } finally {
    guard.release();
  }
}

function presentSegment(record: SegmentRecord): Record<string, unknown> {
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
