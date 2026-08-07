import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "../engine/atomic";
import type { CompactionManifest, SegmentEntry } from "../engine/segments";
import { CompactionError } from "./compaction/types";
import { rustLines, rustTrim } from "./lines";
import { localRfc3339 } from "../time.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";
const SEGMENTS_DIR = "segments";
const COMPACTION_MANIFEST_FILE = "compaction.json";

export class ConversationManagerError extends CompactionError {
  constructor(message: string) {
    super("conversation", `conversation: ${message}`);
    this.name = "ConversationManagerError";
  }
}

export interface RetentionParams {
  keepLastN: number;
  activeContent: string;
}

function messageLines(content: string): string[] {
  return rustLines(content).filter((l) => rustTrim(l) !== "");
}

function parseManifest(raw: string, path: string): CompactionManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new ConversationManagerError(
      `failed to parse ${COMPACTION_MANIFEST_FILE}: ${(e as Error).message}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConversationManagerError(
      `failed to parse ${COMPACTION_MANIFEST_FILE}: expected an object`,
    );
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.segments)) {
    throw new ConversationManagerError(
      `failed to parse ${COMPACTION_MANIFEST_FILE}: missing field \`segments\``,
    );
  }
  if (typeof obj.total_compacted_messages !== "number") {
    throw new ConversationManagerError(
      `failed to parse ${COMPACTION_MANIFEST_FILE}: missing field \`total_compacted_messages\``,
    );
  }
  void path;
  return {
    segments: obj.segments as SegmentEntry[],
    total_compacted_messages: obj.total_compacted_messages,
  };
}

export class ConversationArchiver {
  readonly #characterDir: string;

  constructor(characterDir: string) {
    this.#characterDir = characterDir;
  }

  async archiveAndRetain(params: RetentionParams): Promise<string> {
    const activePath = join(this.#characterDir, ACTIVE_JSONL_FILE);

    const lines = messageLines(params.activeContent);

    const keep = Math.min(params.keepLastN, lines.length);
    const splitAt = lines.length - keep;
    const archiveLines = lines.slice(0, splitAt);
    const retainedLines = lines.slice(splitAt);

    if (archiveLines.length > 0) {
      const manifestPath = join(this.#characterDir, COMPACTION_MANIFEST_FILE);

      let manifest: CompactionManifest;
      let raw: string | undefined;
      try {
        raw = await readFile(manifestPath, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ConversationManagerError(
            `failed to read ${COMPACTION_MANIFEST_FILE}: ${(e as Error).message}`,
          );
        }
      }
      manifest =
        raw === undefined
          ? { segments: [], total_compacted_messages: 0 }
          : parseManifest(raw, manifestPath);

      const segmentIndex = manifest.segments.length + 1;
      const segmentFile = `${String(segmentIndex).padStart(4, "0")}.jsonl`;
      const segmentsDir = join(this.#characterDir, SEGMENTS_DIR);

      try {
        await mkdir(segmentsDir, { recursive: true });
      } catch (e) {
        throw new ConversationManagerError(
          `failed to create segments dir: ${(e as Error).message}`,
        );
      }

      try {
        await writeFile(
          join(segmentsDir, segmentFile),
          `${archiveLines.join("\n")}\n`,
          "utf8",
        );
      } catch (e) {
        throw new ConversationManagerError(
          `failed to write segment file: ${(e as Error).message}`,
        );
      }

      manifest.segments.push({
        file: segmentFile,
        message_count: archiveLines.length,
        compacted_at: localRfc3339(new Date()),
      });
      manifest.total_compacted_messages += archiveLines.length;

      try {
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      } catch (e) {
        throw new ConversationManagerError(
          `failed to write ${COMPACTION_MANIFEST_FILE}: ${(e as Error).message}`,
        );
      }
    }

    const retainedContent =
      retainedLines.length === 0 ? "" : `${retainedLines.join("\n")}\n`;
    try {
      await atomicWrite(activePath, retainedContent);
    } catch (e) {
      throw new ConversationManagerError(
        `failed to write retained messages: ${(e as Error).message}`,
      );
    }

    return crypto.randomUUID();
  }
}
