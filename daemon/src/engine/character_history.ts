import { existsSync } from "node:fs";

import { HistoryStore, type SegmentRecord } from "./history_store.ts";
import { SegmentReader } from "./segments.ts";
import type { Message } from "./types.ts";

export interface CharacterHistoryRef {
  character: string;
  dbPath: string;
  mainConversationDir: string;
}

export interface CharacterSegment extends SegmentRecord {
  archiveKey: string;
}

export class CharacterHistoryReader {
  private constructor(
    readonly ref: CharacterHistoryRef,
    readonly main: SegmentReader,
    readonly store: HistoryStore | undefined,
  ) {}

  static async load(ref: CharacterHistoryRef): Promise<CharacterHistoryReader> {
    const main = await SegmentReader.load({
      dir: ref.mainConversationDir,
      dbPath: ref.dbPath,
      archiveKey: ref.character,
      createHistoryDb: false,
    });
    try {
      const store = existsSync(ref.dbPath) ? HistoryStore.open(ref.dbPath) : undefined;
      return new CharacterHistoryReader(ref, main, store);
    } catch (error) {
      main.close();
      throw error;
    }
  }

  entries(): CharacterSegment[] {
    const entries = this.main.entries().map((entry) => ({ ...entry, archiveKey: this.ref.character }));
    for (const archiveKey of this.store?.archiveKeys(this.ref.character) ?? []) {
      if (archiveKey === this.ref.character) continue;
      for (const entry of this.store?.entries(archiveKey) ?? []) entries.push({ ...entry, archiveKey });
    }
    return entries;
  }

  async readSegment(archiveKey: string, segment: number): Promise<Message[]> {
    if (archiveKey === this.ref.character) return await this.main.readSegment(segment);
    if (!archiveKey.startsWith(`${this.ref.character}/`)) {
      throw new Error(`archive ${archiveKey} does not belong to ${this.ref.character}`);
    }
    return this.store?.readSegment(archiveKey, segment) ?? [];
  }

  readSegmentOrdinals(archiveKey: string, segment: number, ordinals: readonly number[]): Map<number, Message> {
    if (archiveKey === this.ref.character) return this.main.readSegmentOrdinals(segment, ordinals);
    if (!archiveKey.startsWith(`${this.ref.character}/`)) {
      throw new Error(`archive ${archiveKey} does not belong to ${this.ref.character}`);
    }
    return this.store?.readSegmentOrdinals(archiveKey, segment, ordinals) ?? new Map<number, Message>();
  }

  archiveDigest(): string {
    return JSON.stringify([
      [this.ref.character, this.main.archiveDigest()],
      ...(this.store?.archiveKeys(this.ref.character) ?? [])
        .filter((key) => key !== this.ref.character)
        .map((key) => [key, this.store?.archiveDigest(key)]),
    ]);
  }

  close(): void {
    this.main.close();
    this.store?.close();
  }
}
