/**
 * The writer half of compaction — the side that freezes conversation history.
 *
 * Ported from `RealConversationManager` in
 * `crates/daemon/src/memory/compaction_impls.rs`, pinned by
 * `tests/memory_fixtures/compaction_writer_parity.json`.
 *
 * `engine/segments.ts` is the reader and landed first, deliberately, with a
 * note that its writer "still lives in Rust and moves with the memory module".
 * This is that move: `compaction.json` and `segments/` are now written by
 * TypeScript, and #12's ownership rule is satisfied for both files.
 *
 * # This never parses a message
 *
 * `archiveAndRetain` is line-based from end to end. It splits `active.jsonl`
 * on newlines, moves a prefix of those lines into a segment file, and writes
 * the rest back. A line that is not valid JSON is carried across verbatim —
 * the fixture pins `not json at all` and a truncated `{"unclosed":` surviving
 * into a segment untouched. That is deliberate in the Rust and worth keeping:
 * compaction must not be able to destroy a message it merely failed to parse.
 *
 * # The manifest counts segments, not files
 *
 * The next segment number comes from `manifest.segments.length + 1`, so a
 * manifest that disagrees with what is on disk will overwrite an existing
 * segment rather than skip past it. Reproduced rather than fixed: the manifest
 * is the authority on the reader side too, and making the writer scan the
 * directory instead would make the two halves disagree about what exists.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CompactionManifest, SegmentEntry } from "../engine/segments";
import { rustLines } from "./lines";

/** Matches `shore_common::config` — the three paths this module owns. */
const ACTIVE_JSONL_FILE = "active.jsonl";
const SEGMENTS_DIR = "segments";
const COMPACTION_MANIFEST_FILE = "compaction.json";

/**
 * A failure inside archive-and-retain.
 *
 * The Rust wrapped every one of these in `CompactionError::ConversationManager`,
 * whose Display is `conversation: {message}`. Kept, because the compaction
 * manager above this distinguishes error variants when deciding whether a pass
 * may archive.
 */
export class ConversationManagerError extends Error {
  constructor(message: string) {
    super(`conversation: ${message}`);
    this.name = "ConversationManagerError";
  }
}

/** Parameters for archiving with message retention. */
export interface RetentionParams {
  /** Number of messages to keep from the end of `active.jsonl`. */
  keepLastN: number;
  /**
   * Pre-read content of `active.jsonl` from when the messages were parsed.
   *
   * This is the authority, not the file — it closes the TOCTOU window where
   * the file changes between the caller analysing messages and this write. The
   * fixture pins a case where the two disagree and the parameter wins.
   */
  activeContent: string;
}

/**
 * The message lines of an `active.jsonl`, matching the Rust's
 * `.lines().filter(|l| !l.trim().is_empty())`.
 *
 * The `\r` stripping in {@link rustLines} is what makes this correct on a CRLF
 * file: a plain `split("\n")` leaves the `\r` attached, and it would be
 * written straight through into the segment. Pinned by the fixture's CRLF
 * case. `rustLines`' other rule — no empty final element for a trailing
 * newline — is invisible here, since the blank filter would have removed it.
 */
function messageLines(content: string): string[] {
  return rustLines(content).filter((l) => l.trim() !== "");
}

/**
 * RFC 3339 with the local UTC offset, matching `chrono::Local::now().to_rfc3339()`.
 *
 * Deliberate divergence: the Rust emits nanosecond precision, JavaScript only
 * has milliseconds, so this writes three fractional digits where the Rust
 * wrote nine. Padding with six zeros would claim a precision that is not
 * there. Nothing reads this field — `engine/segments.ts` carries it as an
 * opaque string and never parses it — so the shape is what matters.
 */
function localRfc3339(now: Date): string {
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Parse `compaction.json` the way serde did — strictly.
 *
 * `CompactionManifest` derives `Default` but carries no `#[serde(default)]`,
 * so a manifest missing either field is a hard error rather than an empty
 * read. That distinction matters: silently treating a truncated manifest as
 * "no history" makes an unknown number of archived messages invisible, and
 * the next compaction would then overwrite `0001.jsonl`.
 *
 * `engine/segments.ts` got this wrong on the reader side — it claimed
 * `#[serde(default)]` in a comment and coalesced both fields — and the frozen
 * `engine_parity.json` had no case covering it. Fixed there in this commit.
 */
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

/** Write through a same-directory temp file and a rename. */
async function atomicWrite(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/**
 * Archives conversation history into numbered segment files, keeping a tail of
 * recent messages live in `active.jsonl`.
 */
export class ConversationArchiver {
  readonly #characterDir: string;

  constructor(characterDir: string) {
    this.#characterDir = characterDir;
  }

  /**
   * Move all but the last `keepLastN` messages into a new segment.
   *
   * Returns a fresh conversation id. The Rust returned a v4 UUID and no caller
   * derives anything from it, so this does the same.
   *
   * Ordering is load-bearing: the segment and the manifest are written before
   * `active.jsonl` is truncated. A crash between them re-archives on the next
   * pass, which is recoverable; the reverse order would drop messages.
   */
  async archiveAndRetain(params: RetentionParams): Promise<string> {
    const activePath = join(this.#characterDir, ACTIVE_JSONL_FILE);

    const lines = messageLines(params.activeContent);

    // The clamp is load-bearing, not defensive. Without it a `keepLastN` above
    // the line count gives a negative split point, and `slice(0, -n)` archives
    // the *head* instead of nothing — silently moving live messages into a
    // segment. Pinned by the keep=15/len=10 case.
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

      // Numbering follows the manifest, not the directory. See the module note.
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

      // `serde_json::to_string_pretty` — two-space indent, no trailing newline.
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
