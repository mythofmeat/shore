import { refreshConversation, withConversation } from "../../engine/lifecycle.ts";
import { writeDurable, archiveFile } from "../../storage/files.ts";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { forgetThreadSessions } from "../../llm/providers/agent_sessions.ts";
import { MAIN_THREAD } from "../../config/dirs.ts";


import { HISTORY_DB_FILE, HistoryStore } from "../../engine/history_store.ts";
import { normalizeMessage } from "../../engine/message_store.ts";
import { type ConversationRef } from "../../engine/segments.ts";
import type { Message } from "../../engine/types.ts";
import { rustLines, rustTrim } from "../lines.ts";
import { CompactionError } from "./types.ts";
import type { ConversationManager } from "./types.ts";


export interface DurableHistoryLocation {
  dbPath: string;
  archiveKey: string;
  coverageClaim?: string;
}

export function conversationManager(
  characterDir: string,
  history: DurableHistoryLocation,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): ConversationManager {
  return {
    archiveAndRetain: (_conversationId, params) =>
      archiveAndRetain(
        characterDir,
        { ...history, ...(params.coverageClaim === undefined ? {} : { coverageClaim: params.coverageClaim }) },
        params.keepLastN,
        params.activeContent,
        now,
        newId,
        params.operationId,
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
  history: DurableHistoryLocation,
  keepLastN: number,
  activeContent: string,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
  operationId?: string,
  segmentMetadata: Pick<
    import("../../engine/history_store.ts").SegmentEntry,
    "memory_before" | "memory_after" | "excluded" | "note"
  > = {},
): Promise<string> {
  return await withConversation(characterDir, "rewrite", async () => {
    const lines = rustLines(activeContent).filter((l) => rustTrim(l) !== "");
    const keep = Math.min(keepLastN, lines.length);
    const splitAt = lines.length - keep;
    const archived = lines.slice(0, splitAt);
    const retained = lines.slice(splitAt);
    const retainedContent = retained.length === 0 ? "" : retained.join("\n") + "\n";

    if (archived.length > 0) {
      await archiveToDatabase(
        history,
        archived,
        retainedContent,
        activeContent,
        now,
        operationId,
        segmentMetadata,
      );
      const [character, thread = MAIN_THREAD] = history.archiveKey.split("/");
      if (character !== undefined) forgetThreadSessions(dirname(history.dbPath), character, thread, Date.parse(now()));
      await refreshConversation(characterDir);
      return newId();
    }

    try {
      writeDurable(archiveFile(history.dbPath, history.archiveKey, "active.jsonl"), retainedContent);
    } catch (e) {
      throw CompactionError.conversationManager(`failed to write retained messages: ${message(e)}`);
    }

    await refreshConversation(characterDir);
    return newId();
  });
}

async function archiveToDatabase(
  history: DurableHistoryLocation,
  archived: readonly string[],
  retainedContent: string,
  activeContent: string,
  now: () => string,
  operationId: string | undefined,
  segmentMetadata: Pick<
    import("../../engine/history_store.ts").SegmentEntry,
    "memory_before" | "memory_after" | "excluded" | "note"
  >,
): Promise<void> {
  const messages = archived.map((line) => normalizeMessage(JSON.parse(line) as Message));
  const store = HistoryStore.open(history.dbPath);
  let idx: number | undefined;
  try {
    store.recoverPending(history.archiveKey, activeContent);
    if (operationId === undefined || !store.hasCompactionOperation(history.archiveKey, operationId)) {
      idx = store.beginCompaction(
        history.archiveKey,
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
        history.coverageClaim,
      );
    }
    try {
      writeDurable(archiveFile(history.dbPath, history.archiveKey, "active.jsonl"), retainedContent);
    } catch (e) {
      if (idx !== undefined) store.abortCompaction(history.archiveKey, idx);
      throw CompactionError.conversationManager(`failed to write retained messages: ${message(e)}`);
    }
    if (idx !== undefined) store.finishCompaction(history.archiveKey, idx);
  } finally {
    store.close();
  }
}

export async function segmentCount(ref: ConversationRef): Promise<number> {
  return withHistoryStore(ref, (store, character) => store.segmentCount(character)) ?? 0;
}

function withHistoryStore<T>(
  ref: ConversationRef,
  read: (store: HistoryStore, character: string) => T,
): T | undefined {
  if (!existsSync(ref.dbPath)) return undefined;
  let store: HistoryStore | undefined;
  try {
    store = HistoryStore.open(ref.dbPath);
    return read(store, ref.archiveKey);
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}

export async function hasCompactionOperation(ref: ConversationRef, operationId: string): Promise<boolean> {
  return withHistoryStore(ref, (store, character) => store.hasCompactionOperation(character, operationId)) ?? false;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
