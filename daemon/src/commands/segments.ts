import { homeThreadOf, isValidThreadId, readThreadsIndex } from "../engine/threads.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { readDurable, threadFile } from "../storage/files.ts";
import { join } from "node:path";

import {
  MAIN_THREAD,
  archiveKey,
  characterDataDir,
  threadDataDir,
} from "../config/dirs.ts";

import { HISTORY_DB_FILE, HistoryStore, type ArchivedCopy } from "../engine/history_store.ts";
import { presentSegment } from "../engine/segments.ts";
import { archiveAndRetain } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { resetActivePromptSnapshot } from "../memory/deferred_edits.ts";
import { withHistoryIndexLock } from "../memory/history_index.ts";
import { CommandError, internalError, invalidRequest, notFound } from "./errors.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { MessageCopy } from "../protocol/MessageCopy.ts";
import type { SegmentAction } from "../protocol/SegmentAction.ts";
import type { SegmentsFound } from "../protocol/SegmentsFound.ts";
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
  if (action === "find") return await findMessages(dataDir, character, args["msg_ids"]);
  const target = targetThread(args["thread"], thread);
  const mutate = () =>
    runSegments(dataDir, character, target, action, args, historyIndex);
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
  action: Exclude<SegmentAction, "find">,
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
        {
          dbPath: join(ctx.dataDir, HISTORY_DB_FILE),
          archiveKey: archiveKey(character, engine.thread),
        },
        0,
        activeContent,
        ctx.now ?? (() => new Date().toISOString()),
        ctx.newId ?? (() => crypto.randomUUID()),
        `clear-${crypto.randomUUID()}`,
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

async function findMessages(dataDir: string, character: string, value: unknown): Promise<SegmentsFound> {
  const ids = messageIds(value);
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  let archived: ArchivedCopy[];
  try {
    archived = store.archivedCopies(character, ids);
  } finally {
    store.close();
  }
  const copies = new Map<string, MessageCopy[]>(ids.map((id) => [id, []]));
  for (const copy of archived) {
    const thread = copy.archiveKey === character ? MAIN_THREAD : copy.archiveKey.slice(character.length + 1);
    copies.get(copy.msg_id)?.push({ thread, segment: copy.segment, excluded: copy.excluded });
  }
  const index = await readThreadsIndex(dataDir, character);
  for (const thread of index?.threads.map((record) => record.id) ?? [MAIN_THREAD]) {
    for (const id of new Set(activeMessageIds(dataDir, character, thread))) {
      copies.get(id)?.push({ thread, segment: null, excluded: false });
    }
  }
  return {
    character,
    found: [...copies].map(([msg_id, found]) => ({ msg_id, copies: found.sort(copyOrder) })),
  };
}

function activeMessageIds(dataDir: string, character: string, thread: string): string[] {
  let raw: string;
  try {
    raw = readDurable(threadFile(dataDir, character, thread, "active.jsonl"));
  } catch {
    return [];
  }
  return raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const id = (JSON.parse(line) as { msg_id?: unknown }).msg_id;
      return typeof id === "string" ? [id] : [];
    } catch {
      return [];
    }
  });
}

function copyOrder(a: MessageCopy, b: MessageCopy): number {
  if (a.thread !== b.thread) {
    if (a.thread === MAIN_THREAD || b.thread === MAIN_THREAD) return a.thread === MAIN_THREAD ? -1 : 1;
    return a.thread < b.thread ? -1 : 1;
  }
  return (a.segment ?? Number.MAX_SAFE_INTEGER) - (b.segment ?? Number.MAX_SAFE_INTEGER);
}

function messageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id): id is string => typeof id === "string" && id.trim() !== "")) {
    throw invalidRequest("find needs msg_ids, one or more message ids");
  }
  return [...new Set(value.map((id) => id.trim()))];
}

function targetThread(value: unknown, current: string): string {
  if (value === undefined || value === null) return current;
  if (typeof value !== "string" || !isValidThreadId(value)) throw invalidRequest(`invalid thread ${JSON.stringify(value)}`);
  return value;
}

function missing(idx: number, character: string, thread: string): string {
  const where = thread === MAIN_THREAD ? character : `${character} thread ${thread}`;
  return `segment ${String(idx)} not found for ${where}`;
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
