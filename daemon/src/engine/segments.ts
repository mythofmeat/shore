import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { MessageNotFound, JsonParseError, normalizeMessage } from "./message_store";
import type { Message } from "./types";

const SEGMENTS_DIR = "segments";
const COMPACTION_MANIFEST_FILE = "compaction.json";

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

  private constructor(segmentsDir: string, manifest: CompactionManifest) {
    this.#segmentsDir = segmentsDir;
    this.#manifest = manifest;
  }

  static async load(characterDir: string): Promise<SegmentReader> {
    const manifestPath = join(characterDir, COMPACTION_MANIFEST_FILE);
    const segmentsDir = join(characterDir, SEGMENTS_DIR);

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return new SegmentReader(segmentsDir, EMPTY_MANIFEST);
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
    return new SegmentReader(segmentsDir, manifest);
  }

  segmentCount(): number {
    return this.#manifest.segments.length;
  }

  totalMessageCount(): number {
    return this.#manifest.total_compacted_messages;
  }

  entries(): readonly SegmentEntry[] {
    return this.#manifest.segments;
  }

  async readSegment(index: number): Promise<Message[]> {
    const entry = this.#manifest.segments[index];
    if (entry === undefined) {
      throw new MessageNotFound(`segment index ${index}`);
    }

    const path = join(this.#segmentsDir, entry.file);
    const content = await readFile(path, "utf8");

    const messages: Message[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      let parsed: Message;
      try {
        parsed = JSON.parse(line) as Message;
      } catch (e) {
        throw new JsonParseError(path, (e as Error).message);
      }
      messages.push(normalizeMessage(parsed));
    }
    return messages;
  }
}
