import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "../../engine/atomic.ts";
import type { CompactionManifest } from "../../engine/segments.ts";
import { rustLines, rustTrim } from "../lines.ts";
import { CompactionError } from "./types.ts";
import type { ConversationManager } from "./types.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";
const COMPACTION_MANIFEST_FILE = "compaction.json";
const SEGMENTS_DIR = "segments";

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

export async function archiveAndRetain(
  characterDir: string,
  keepLastN: number,
  activeContent: string,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): Promise<string> {
  const lines = rustLines(activeContent).filter((l) => rustTrim(l) !== "");
  const keep = Math.min(keepLastN, lines.length);
  const splitAt = lines.length - keep;
  const archived = lines.slice(0, splitAt);
  const retained = lines.slice(splitAt);

  if (archived.length > 0) {
    await writeSegment(characterDir, archived, now);
  }

  const retainedContent = retained.length === 0 ? "" : retained.join("\n") + "\n";
  try {
    await atomicWrite(join(characterDir, ACTIVE_JSONL_FILE), retainedContent);
  } catch (e) {
    throw CompactionError.conversationManager(`failed to write retained messages: ${message(e)}`);
  }

  return newId();
}

async function writeSegment(
  characterDir: string,
  archived: readonly string[],
  now: () => string,
): Promise<void> {
  const manifestPath = join(characterDir, COMPACTION_MANIFEST_FILE);
  const manifest = await readManifest(manifestPath);

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
  try {
    return (await readManifest(join(characterDir, COMPACTION_MANIFEST_FILE))).segments.length;
  } catch {
    return 0;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
