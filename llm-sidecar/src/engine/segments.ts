/**
 * Frozen conversation history — the segment files compaction leaves behind.
 *
 * Ported from `crates/daemon/src/engine/segments.rs`, pinned by
 * `tests/engine_fixtures/engine_parity.json`.
 *
 * Compaction moves older messages out of `active.jsonl` into numbered JSONL
 * files under `segments/`, and records them in `compaction.json`. Each segment
 * is immutable once written, so this side only ever reads.
 *
 * # The manifest is the authority, not the files
 *
 * `totalMessageCount` comes from the manifest's own counter and is never
 * recomputed from what the segment files contain. The two can disagree — the
 * fixture pins a manifest claiming 99 messages over three real ones — and the
 * manifest still wins. That is what the Rust did, and it matters because the
 * count feeds the client's "N archived messages" display while the files are
 * only read when someone scrolls back that far.
 *
 * The writer still lives in Rust (`memory/compaction_impls.rs`) and moves with
 * the memory module (#12, step 5). Nothing here depends on that: a segment is
 * finished the moment it is written, so reading one is not racing anybody.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { MessageNotFound, JsonParseError, normalizeMessage } from "./message_store";
import type { Message } from "./types";

/** Where a character's frozen segments and their manifest live. */
const SEGMENTS_DIR = "segments";
const COMPACTION_MANIFEST_FILE = "compaction.json";

/** Metadata for one frozen segment file. */
export interface SegmentEntry {
  file: string;
  message_count: number;
  compacted_at: string;
}

/**
 * `compaction.json`. Absent means no compaction has happened yet, which is not
 * an error — a character that has never been compacted has no history to read.
 */
export interface CompactionManifest {
  segments: SegmentEntry[];
  total_compacted_messages: number;
}

const EMPTY_MANIFEST: CompactionManifest = {
  segments: [],
  total_compacted_messages: 0,
};

/** Read-only access to a character's frozen conversation segments. */
export class SegmentReader {
  readonly #segmentsDir: string;
  readonly #manifest: CompactionManifest;

  private constructor(segmentsDir: string, manifest: CompactionManifest) {
    this.#segmentsDir = segmentsDir;
    this.#manifest = manifest;
  }

  /**
   * Read the manifest from a character directory.
   *
   * A missing `compaction.json` yields an empty reader. A *corrupt* one does
   * not: it throws, the same as the Rust, because a manifest that will not
   * parse means an unknown amount of history is silently invisible.
   */
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
    // `#[serde(default)]` on both fields: a manifest missing either is read as
    // empty rather than rejected.
    return new SegmentReader(segmentsDir, {
      segments: manifest.segments ?? [],
      total_compacted_messages: manifest.total_compacted_messages ?? 0,
    });
  }

  /** Number of frozen segments. */
  segmentCount(): number {
    return this.#manifest.segments.length;
  }

  /** Total messages across all frozen segments, as the manifest reports it. */
  totalMessageCount(): number {
    return this.#manifest.total_compacted_messages;
  }

  /** The manifest entries, in order. */
  entries(): readonly SegmentEntry[] {
    return this.#manifest.segments;
  }

  /**
   * Load one segment's messages by index.
   *
   * An out-of-range index throws `MessageNotFound` — the Rust reused its
   * message-not-found variant for a missing *segment*, so the text reads
   * "message not found: segment index 3". Odd, and reproduced rather than
   * tidied: it is what a client sees today.
   */
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
