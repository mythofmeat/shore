/**
 * The write half of a compaction pass: archive what was compacted, keep the
 * rest.
 *
 * Ported from `RealConversationManager::archive_and_retain` in
 * `crates/daemon/src/memory/compaction_impls.rs`, pinned by
 * `tests/memory_fixtures/compaction_assembly_parity.json`.
 *
 * `engine/segments.ts` has been waiting for this since it ported — it is the
 * reader for exactly these files, and until now nothing on this side wrote
 * them. Three things happen, in this order:
 *
 * 1. The conversation is split **by line**, from the end. Not by message and
 *    not by turn: `keepLastN` arrives already computed by the pass, which did
 *    the turn arithmetic, and this only has to agree with it about what a line
 *    is. Blank lines are dropped first, so a stray newline cannot shift the
 *    split by one.
 * 2. The archived part becomes the next numbered segment, and the manifest
 *    grows an entry. The number comes off the manifest's own length, so a
 *    manifest that was never written starts at `0001`.
 * 3. What is left is written back to `active.jsonl`, atomically.
 *
 * # The split is computed against what the pass read, not what is on disk
 *
 * `activeContent` is the bytes the pass parsed its messages from, and they are
 * what gets split — the file may have grown since. That is deliberate in the
 * Rust and kept here: computing the split against a file that moved underneath
 * the pass would archive a different set of messages than the one the model was
 * shown.
 *
 * It has a cost, and the fixture records it rather than hiding it: a turn that
 * arrives *during* a pass is in neither half, so the retained write drops it.
 * Fixing that means merging, which is a design decision rather than a port's.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "../../engine/atomic.ts";
import type { CompactionManifest } from "../../engine/segments.ts";
import { CompactionError } from "./types.ts";
import type { ConversationManager } from "./types.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";
const COMPACTION_MANIFEST_FILE = "compaction.json";
const SEGMENTS_DIR = "segments";

/**
 * A {@link ConversationManager} over one character's directory.
 *
 * `now` is injected for the manifest's timestamp, which is the only
 * non-deterministic thing here besides the id it returns.
 */
export function conversationManager(
  characterDir: string,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): ConversationManager {
  return {
    archiveAndRetain: (_conversationId, params) =>
      archiveAndRetain(characterDir, params.keepLastN, params.activeContent, now, newId),
  };
}

/**
 * Split, archive, and rewrite. Returns a fresh conversation id.
 *
 * The id is a plain uuid and nothing reads it back — the Rust returned one and
 * the pass logs it. It is here because the interface says so.
 */
export async function archiveAndRetain(
  characterDir: string,
  keepLastN: number,
  activeContent: string,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): Promise<string> {
  const lines = activeContent.split("\n").filter((l) => l.trim() !== "");
  const keep = Math.min(keepLastN, lines.length);
  const splitAt = lines.length - keep;
  const archived = lines.slice(0, splitAt);
  const retained = lines.slice(splitAt);

  if (archived.length > 0) {
    await writeSegment(characterDir, archived, now);
  }

  // An empty conversation is written as empty, not as a blank line: the reader
  // filters blanks, but a file that is one newline is not the same file.
  const retainedContent = retained.length === 0 ? "" : retained.join("\n") + "\n";
  try {
    await atomicWrite(join(characterDir, ACTIVE_JSONL_FILE), retainedContent);
  } catch (e) {
    throw CompactionError.conversationManager(`failed to write retained messages: ${message(e)}`);
  }

  return newId();
}

/** Write the next numbered segment and record it in the manifest. */
async function writeSegment(
  characterDir: string,
  archived: readonly string[],
  now: () => string,
): Promise<void> {
  const manifestPath = join(characterDir, COMPACTION_MANIFEST_FILE);
  const manifest = await readManifest(manifestPath);

  // The index is the manifest's length plus one, so it survives a segments
  // directory that has been tidied by hand — the manifest is the record, and
  // the files are what it points at.
  const segmentIndex = manifest.segments.length + 1;
  const segmentFile = `${String(segmentIndex).padStart(4, "0")}.jsonl`;
  const segmentsDir = join(characterDir, SEGMENTS_DIR);

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

  manifest.segments.push({
    file: segmentFile,
    message_count: archived.length,
    compacted_at: now(),
  });
  manifest.total_compacted_messages += archived.length;

  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    throw CompactionError.conversationManager(`failed to write compaction.json: ${message(e)}`);
  }
}

/** The manifest on disk, or a fresh one. A malformed manifest is fatal. */
async function readManifest(path: string): Promise<CompactionManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Absent is the ordinary first-pass case and not an error; anything else
    // that stops the read shows up on the write below.
    return { segments: [], total_compacted_messages: 0 };
  }
  try {
    return JSON.parse(raw) as CompactionManifest;
  } catch (e) {
    throw CompactionError.conversationManager(`failed to parse compaction.json: ${message(e)}`);
  }
}

/** How many segments a character has, for the callers that only want the count. */
export async function segmentCount(characterDir: string): Promise<number> {
  try {
    const entries = await readdir(join(characterDir, SEGMENTS_DIR));
    return entries.filter((e) => e.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
