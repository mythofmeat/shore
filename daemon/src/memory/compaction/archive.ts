import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { atomicWrite } from "../../engine/atomic.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../../engine/history_store.ts";
import { normalizeMessage } from "../../engine/message_store.ts";
import { SegmentReader, type CompactionManifest } from "../../engine/segments.ts";
import type { Message } from "../../engine/types.ts";
import { rustLines, rustTrim } from "../lines.ts";
import { CompactionError } from "./types.ts";
import type { ConversationManager } from "./types.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";
const COMPACTION_MANIFEST_FILE = "compaction.json";
const SEGMENTS_DIR = "segments";

export interface DurableHistoryLocation {
  dbPath: string;
  character: string;
}

export function conversationManager(
  characterDir: string,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
  history?: DurableHistoryLocation,
): ConversationManager {
  return {
    archiveAndRetain: (_conversationId, params) =>
      archiveAndRetain(
        characterDir,
        params.keepLastN,
        params.activeContent,
        now,
        newId,
        params.operationId,
        history,
        {
          ...(params.memoryBefore === undefined ? {} : { memory_before: params.memoryBefore }),
          ...(params.memoryAfter === undefined ? {} : { memory_after: params.memoryAfter }),
          ...(params.excluded === true ? { excluded: true } : {}),
          ...(params.note === undefined ? {} : { note: params.note }),
        },
      ),
  };
}

export async function archiveAndRetain(
  characterDir: string,
  keepLastN: number,
  activeContent: string,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
  operationId?: string,
  history?: DurableHistoryLocation,
  segmentMetadata: Pick<
    import("../../engine/history_store.ts").SegmentEntry,
    "memory_before" | "memory_after" | "excluded" | "note"
  > = {},
): Promise<string> {
  const lines = rustLines(activeContent).filter((l) => rustTrim(l) !== "");
  const keep = Math.min(keepLastN, lines.length);
  const splitAt = lines.length - keep;
  const archived = lines.slice(0, splitAt);
  const retained = lines.slice(splitAt);
  const retainedContent = retained.length === 0 ? "" : retained.join("\n") + "\n";

  if (history !== undefined && archived.length > 0) {
    await archiveToDatabase(
      history,
      archived,
      retainedContent,
      activeContent,
      now,
      operationId,
      characterDir,
      segmentMetadata,
    );
    return newId();
  }

  if (archived.length > 0) {
    await writeSegment(characterDir, archived, now, operationId);
  }

  try {
    await atomicWrite(join(characterDir, ACTIVE_JSONL_FILE), retainedContent);
  } catch (e) {
    throw CompactionError.conversationManager(`failed to write retained messages: ${message(e)}`);
  }

  return newId();
}

async function archiveToDatabase(
  history: DurableHistoryLocation,
  archived: readonly string[],
  retainedContent: string,
  activeContent: string,
  now: () => string,
  operationId: string | undefined,
  characterDir: string,
  segmentMetadata: Pick<
    import("../../engine/history_store.ts").SegmentEntry,
    "memory_before" | "memory_after" | "excluded" | "note"
  >,
): Promise<void> {
  const messages = archived.map((line) => normalizeMessage(JSON.parse(line) as Message));
  const reader = await SegmentReader.load(characterDir, {
    dbPath: history.dbPath,
    character: history.character,
  });
  reader.close();
  const store = HistoryStore.open(history.dbPath);
  let idx: number | undefined;
  try {
    store.recoverPending(history.character, activeContent);
    if (operationId === undefined || !store.hasCompactionOperation(history.character, operationId)) {
      idx = store.beginCompaction(
        history.character,
        {
          file: HISTORY_DB_FILE,
          message_count: messages.length,
          compacted_at: now(),
          ...(operationId === undefined ? {} : { compaction_id: operationId }),
          ...segmentMetadata,
        },
        messages,
        activeContent,
        retainedContent,
      );
    }
    try {
      await atomicWrite(join(characterDir, ACTIVE_JSONL_FILE), retainedContent);
    } catch (e) {
      if (idx !== undefined) store.abortCompaction(history.character, idx);
      throw CompactionError.conversationManager(`failed to write retained messages: ${message(e)}`);
    }
    if (idx !== undefined) store.finishCompaction(history.character, idx);
  } finally {
    store.close();
  }
}

interface WrittenSegment {
  idx: number;
  entry: CompactionManifest["segments"][number];
}

async function writeSegment(
  characterDir: string,
  archived: readonly string[],
  now: () => string,
  operationId?: string,
): Promise<WrittenSegment> {
  const manifestPath = join(characterDir, COMPACTION_MANIFEST_FILE);
  const manifest = await readManifest(manifestPath);
  if (operationId !== undefined) {
    const idx = manifest.segments.findIndex((segment) => segment.compaction_id === operationId);
    const entry = manifest.segments[idx];
    if (idx >= 0 && entry !== undefined) return { idx, entry };
  }

  const segmentIndex = manifest.segments.length + 1;
  const segmentFile = `${String(segmentIndex).padStart(4, "0")}.jsonl`;
  const segmentsDir = join(characterDir, SEGMENTS_DIR);
  const compactedAt = now();

  try {
    await mkdir(segmentsDir, { recursive: true });
  } catch (e) {
    throw CompactionError.conversationManager(`failed to create segments dir: ${message(e)}`);
  }
  try {
    await writeFile(join(segmentsDir, segmentFile), archived.join("\n") + "\n");
  } catch (e) {
    throw CompactionError.conversationManager(`failed to write segment file: ${message(e)}`);
  }

  const entry: CompactionManifest["segments"][number] = {
    file: segmentFile,
    message_count: archived.length,
    compacted_at: compactedAt,
    ...(operationId === undefined ? {} : { compaction_id: operationId }),
  };
  manifest.segments.push(entry);
  manifest.total_compacted_messages += archived.length;

  try {
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    throw CompactionError.conversationManager(`failed to write compaction.json: ${message(e)}`);
  }
  return { idx: manifest.segments.length - 1, entry };
}

async function readManifest(path: string): Promise<CompactionManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { segments: [], total_compacted_messages: 0 };
  }
  let parsed: Partial<CompactionManifest>;
  try {
    parsed = JSON.parse(raw) as Partial<CompactionManifest>;
  } catch (e) {
    throw CompactionError.conversationManager(`failed to parse compaction.json: ${message(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.segments)) {
    throw CompactionError.conversationManager(
      "failed to parse compaction.json: missing field `segments`",
    );
  }
  return {
    segments: parsed.segments,
    total_compacted_messages: parsed.total_compacted_messages ?? 0,
  };
}

export async function segmentCount(characterDir: string): Promise<number> {
  return Math.max(await manifestSegmentCount(characterDir), durableSegmentCount(characterDir));
}

async function manifestSegmentCount(characterDir: string): Promise<number> {
  try {
    return (await readManifest(join(characterDir, COMPACTION_MANIFEST_FILE))).segments.length;
  } catch {
    return 0;
  }
}

function durableSegmentCount(characterDir: string): number {
  return withHistoryStore(characterDir, (store, character) => store.segmentCount(character)) ?? 0;
}

function withHistoryStore<T>(
  characterDir: string,
  read: (store: HistoryStore, character: string) => T,
): T | undefined {
  const dbPath = join(dirname(characterDir), HISTORY_DB_FILE);
  if (!existsSync(dbPath)) return undefined;
  let store: HistoryStore | undefined;
  try {
    store = HistoryStore.open(dbPath);
    return read(store, basename(characterDir));
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}

export async function hasCompactionOperation(
  characterDir: string,
  operationId: string,
): Promise<boolean> {
  return (
    (await manifestHasCompactionOperation(characterDir, operationId)) ||
    durableHasCompactionOperation(characterDir, operationId)
  );
}

async function manifestHasCompactionOperation(
  characterDir: string,
  operationId: string,
): Promise<boolean> {
  try {
    const manifest = await readManifest(join(characterDir, COMPACTION_MANIFEST_FILE));
    return manifest.segments.some((segment) => segment.compaction_id === operationId);
  } catch {
    return false;
  }
}

function durableHasCompactionOperation(characterDir: string, operationId: string): boolean {
  return withHistoryStore(characterDir, (store, character) =>
    store.hasCompactionOperation(character, operationId),
  ) ?? false;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
