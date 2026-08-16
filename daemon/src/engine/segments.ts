import { access, readFile, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "./history_store.ts";
import { MessageNotFound, JsonParseError, normalizeMessage } from "./message_store";
import { quarantineLines } from "./backup.ts";
import type { Message } from "./types";

const SEGMENTS_DIR = "segments";
const COMPACTION_MANIFEST_FILE = "compaction.json";
const ACTIVE_JSONL_FILE = "active.jsonl";

export interface SegmentEntry {
  file: string;
  message_count: number;
  compacted_at: string;
  compaction_id?: string;
}

export interface CompactionManifest {
  segments: SegmentEntry[];
  total_compacted_messages: number;
}

const EMPTY_MANIFEST: CompactionManifest = {
  segments: [],
  total_compacted_messages: 0,
};

export class SegmentReader {
  readonly #segmentsDir: string;
  readonly #manifest: CompactionManifest;
  readonly #history: HistoryStore | undefined;
  readonly #character: string;

  private constructor(
    segmentsDir: string,
    manifest: CompactionManifest,
    history: HistoryStore | undefined,
    character: string,
  ) {
    this.#segmentsDir = segmentsDir;
    this.#manifest = manifest;
    this.#history = history;
    this.#character = character;
  }

  static async load(
    characterDir: string,
    durable?: { dbPath: string; character: string },
  ): Promise<SegmentReader> {
    const manifestPath = join(characterDir, COMPACTION_MANIFEST_FILE);
    const segmentsDir = join(characterDir, SEGMENTS_DIR);
    const character = durable?.character ?? basename(characterDir);

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const history = await openHistory(characterDir, durable);
        if (history !== undefined) await recoverPending(history, characterDir, character);
        return new SegmentReader(
          segmentsDir,
          EMPTY_MANIFEST,
          history,
          character,
        );
      }
      throw e;
    }

    let manifest: CompactionManifest;
    try {
      manifest = JSON.parse(raw) as CompactionManifest;
    } catch (e) {
      throw new JsonParseError(manifestPath, (e as Error).message);
    }
    if (!Array.isArray(manifest.segments)) {
      throw new JsonParseError(manifestPath, "missing field `segments`");
    }
    if (typeof manifest.total_compacted_messages !== "number") {
      throw new JsonParseError(
        manifestPath,
        "missing field `total_compacted_messages`",
      );
    }
    const history = await openHistory(characterDir, durable);
    if (history !== undefined) {
      await recoverPending(history, characterDir, character);
      await importLegacySegments(history, character, manifest, segmentsDir, manifestPath);
    }
    return new SegmentReader(segmentsDir, manifest, history, character);
  }

  segmentCount(): number {
    return Math.max(
      this.#manifest.segments.length,
      this.#history?.segmentCount(this.#character) ?? 0,
    );
  }

  totalMessageCount(): number {
    const historyCount = this.#history?.segmentCount(this.#character) ?? 0;
    return historyCount >= this.#manifest.segments.length
      ? (this.#history?.totalMessageCount(this.#character) ?? 0)
      : this.#manifest.total_compacted_messages;
  }

  archiveDigest(): string {
    const durable = this.#history?.archiveDigest(this.#character) ?? "";
    const manifest = this.#manifest.segments
      .map((entry) => `${entry.file}:${entry.message_count}:${entry.compacted_at}`)
      .join(",");
    return `${durable}|${manifest}`;
  }

  entries(): readonly SegmentEntry[] {
    const historyEntries = this.#history?.entries(this.#character) ?? [];
    return historyEntries.length >= this.#manifest.segments.length
      ? historyEntries
      : this.#manifest.segments;
  }

  async readSegment(index: number): Promise<Message[]> {
    if (this.#history?.hasSegment(this.#character, index) === true) {
      return this.#history.readSegment(this.#character, index);
    }

    const entry = this.#manifest.segments[index];
    if (entry === undefined) {
      throw new MessageNotFound(`segment index ${index}`);
    }

    const path = legacySegmentPath(this.#segmentsDir, entry.file);
    const content = await readFile(path, "utf8");

    const messages: Message[] = [];
    const unreadable: string[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      let parsed: Message;
      try {
        parsed = JSON.parse(line) as Message;
      } catch {
        unreadable.push(rawLine);
        continue;
      }
      messages.push(normalizeMessage(parsed));
    }
    if (unreadable.length > 0) {
      const quarantined = await quarantineLines(path, unreadable);
      console.error(
        `shore: ${String(unreadable.length)} unreadable line(s) in segment ${path} were ` +
          `quarantined${quarantined === undefined ? "" : ` to ${quarantined}`}; ` +
          `${String(messages.length)} message(s) recovered`,
      );
    }
    this.#history?.putSegment(this.#character, index, entry, messages);
    return messages;
  }

  close(): void {
    this.#history?.close();
  }
}

async function openHistory(
  characterDir: string,
  durable: { dbPath: string; character: string } | undefined,
): Promise<HistoryStore | undefined> {
  if (durable !== undefined) return HistoryStore.open(durable.dbPath);
  const dbPath = join(dirname(characterDir), HISTORY_DB_FILE);
  try {
    await access(dbPath);
    return HistoryStore.open(dbPath);
  } catch {
    return undefined;
  }
}

async function recoverPending(
  history: HistoryStore,
  characterDir: string,
  character: string,
): Promise<void> {
  let active = "";
  try {
    active = await readFile(join(characterDir, ACTIVE_JSONL_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  history.recoverPending(character, active);
}

async function importLegacySegments(
  history: HistoryStore,
  character: string,
  manifest: CompactionManifest,
  segmentsDir: string,
  manifestPath: string,
): Promise<void> {
  if (manifest.segments.length === 0) return;
  try {
    for (const [idx, entry] of manifest.segments.entries()) {
      const path = legacySegmentPath(segmentsDir, entry.file);
      if (history.hasSegment(character, idx)) {
        try {
          const messages = await readJsonlSegment(path);
          if (JSON.stringify(history.readSegment(character, idx)) !== JSON.stringify(messages)) {
            throw new Error(`database segment ${idx} disagrees with ${entry.file}`);
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      } else {
        const messages = await readJsonlSegment(path);
        history.putSegment(character, idx, entry, messages);
      }
    }
    for (const entry of manifest.segments) {
      await unlinkIfExists(legacySegmentPath(segmentsDir, entry.file));
    }
    await unlinkIfExists(manifestPath);
    try {
      await rmdir(segmentsDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw e;
    }
  } catch (e) {
    console.warn(`shore: legacy history import kept its JSONL source: ${String(e)}`);
  }
}

function legacySegmentPath(segmentsDir: string, file: string): string {
  if (file === "" || basename(file) !== file || file === "." || file === "..") {
    throw new Error(`unsafe legacy history segment path: ${file}`);
  }
  return join(segmentsDir, file);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

async function readJsonlSegment(path: string): Promise<Message[]> {
  const content = await readFile(path, "utf8");
  const messages: Message[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    try {
      messages.push(normalizeMessage(JSON.parse(line) as Message));
    } catch (e) {
      throw new JsonParseError(path, (e as Error).message);
    }
  }
  return messages;
}
