import { readDurable, archiveFile } from "../storage/files.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { archiveKey, threadDataDir } from "../config/dirs.ts";
import {
  HISTORY_DB_FILE,
  HistoryStore,
  type HistoryDisplaySlice,
  type SegmentRecord,
} from "./history_store.ts";
import { MessageNotFound } from "./message_store";
import type { Message } from "./types";

export type { SegmentRecord } from "./history_store.ts";

export interface ConversationRef {
  dir: string;
  dbPath: string;
  archiveKey: string;
  createHistoryDb: boolean;
}

export function conversationRef(
  dataDir: string,
  character: string,
  thread: string,
  createHistoryDb: boolean,
): ConversationRef {
  return {
    dir: threadDataDir(dataDir, character, thread),
    dbPath: join(dataDir, HISTORY_DB_FILE),
    archiveKey: archiveKey(character, thread),
    createHistoryDb,
  };
}

export class SegmentReader {
  private constructor(
    private readonly history: HistoryStore | undefined,
    private readonly character: string,
  ) {}

  static async load(ref: ConversationRef): Promise<SegmentReader> {
    const history = await openHistory(ref);
    if (history !== undefined) await recoverPending(history, ref);
    return new SegmentReader(history, ref.archiveKey);
  }

  segmentCount(): number {
    return this.history?.segmentCount(this.character) ?? 0;
  }

  displayMessageCount(): number {
    return this.history?.displayMessageCount(this.character) ?? 0;
  }

  displayTurnCount(): number {
    return this.history?.displayTurnCount(this.character) ?? 0;
  }

  displayStartForTurns(end: number, turns: number): number {
    return this.history?.displayStartForTurns(this.character, end, turns) ?? end;
  }

  readDisplayRange(start: number, end: number): HistoryDisplaySlice {
    return this.history?.readDisplayRange(this.character, start, end) ?? {
      messages: [],
      metrics: { segments_read: 0, rows_read: 0, decoded_body_bytes: 0 },
    };
  }

  archiveDigest(): string {
    return this.history?.archiveDigest(this.character) ?? "";
  }

  entries(): readonly SegmentRecord[] {
    return this.history?.entries(this.character) ?? [];
  }

  entry(index: number): SegmentRecord | undefined {
    return this.entries().find(entry => entry.idx === index);
  }

  async readSegment(index: number): Promise<Message[]> {
    if (this.history?.hasSegment(this.character, index) !== true) {
      throw new MessageNotFound(`segment index ${index}`);
    }
    return this.history.readSegment(this.character, index);
  }

  close(): void {
    this.history?.close();
  }
}

async function openHistory(ref: ConversationRef): Promise<HistoryStore | undefined> {
  if (!ref.createHistoryDb) {
    try { await access(ref.dbPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return HistoryStore.open(ref.dbPath);
}

async function recoverPending(history: HistoryStore, ref: ConversationRef): Promise<void> {
  let active = "";
  try {
    active = readDurable(archiveFile(ref.dbPath, ref.archiveKey, "active.jsonl"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  history.recoverPending(ref.archiveKey, active);
}
