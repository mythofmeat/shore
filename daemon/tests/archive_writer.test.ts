/**
 * Recorded cases for archive writer.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { archiveAndRetain } from "../src/memory/compaction/archive";
import { CompactionError } from "../src/memory/compaction/types";

interface Case {
  name: string;
  keep_last_n: number;
  active_content_b64: string;
  before: Record<string, string>;
  after: Record<string, string>;
  outcome: { ok: boolean; returns_uuid_v4?: boolean; err?: string };
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "memory_fixtures/archive_writer.json"),
    "utf8",
  ),
) as {
  constants: Record<string, unknown>;
  archive_and_retain: Case[];
};

const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** Recursively snapshot a directory as relative path -> exact content. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(cur: string): Promise<void> {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out[relative(dir, p).replaceAll("\\", "/")] = await readFile(p, "utf8");
    }
  }
  await walk(dir);
  return out;
}

/**
 * Replace every `compacted_at` the writer just stamped with a sentinel, after
 * checking it looks like a timestamp. Entries carried over from a seeded
 * manifest keep their original literal values and are compared for real.
 */
function normalizeManifest(raw: string, seeded: Set<string>): string {
  let parsed: { segments?: { file: string; compacted_at: string }[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return raw; // Malformed on the way in and left untouched; compare verbatim.
  }
  // A rejected manifest is written back by nobody, so it has nothing to stamp.
  if (!Array.isArray(parsed.segments)) return raw;

  // Substitute the stamped timestamps textually rather than re-serialising.
  // An earlier version parsed and re-stringified both sides, which normalised
  // away indentation too and let "manifest written compact" and "indented four
  // spaces" both survive mutation. The whole point of this fixture is that the
  // bytes on disk match, so only the unpinnable value may be replaced.
  let out = raw;
  for (const seg of parsed.segments) {
    if (seeded.has(seg.file)) continue;
    expect(seg.compacted_at).toBeString();
    expect(Number.isNaN(Date.parse(seg.compacted_at))).toBe(false);
    out = out.replace(JSON.stringify(seg.compacted_at), '"<stamped>"');
  }
  return out;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("compaction writer parity", () => {
  test("the fixture pins the path constants this module hardcodes", () => {
    expect(fixture.constants.active_jsonl_file).toBe("active.jsonl");
    expect(fixture.constants.segments_dir).toBe("segments");
    expect(fixture.constants.compaction_manifest_file).toBe("compaction.json");
  });

  for (const c of fixture.archive_and_retain) {
    test(c.name, async () => {
      const dir = await mkdtemp(join(tmpdir(), "compaction-writer-"));
      try {
        // Rebuild the exact directory the Rust started from.
        for (const [rel, content] of Object.entries(c.before)) {
          const p = join(dir, rel);
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, b64(content), "utf8");
        }

        // Segment entries present before the call keep their literal
        // timestamps; only newly stamped ones get normalised.
        const seeded = new Set<string>();
        if (c.before["compaction.json"] !== undefined) {
          try {
            const m = JSON.parse(b64(c.before["compaction.json"])) as {
              segments?: { file: string }[];
            };
            for (const s of m.segments ?? []) seeded.add(s.file);
          } catch {
            // A malformed seeded manifest has no entries to carry over.
          }
        }

        let returned: string | undefined;
        let threw: unknown;
        try {
          returned = await archiveAndRetain(dir, c.keep_last_n, b64(c.active_content_b64));
        } catch (e) {
          threw = e;
        }

        if (c.outcome.ok) {
          expect(threw).toBeUndefined();
          // The Rust returned a v4 UUID; pin the version nibble, not the bytes.
          expect(c.outcome.returns_uuid_v4).toBe(true);
          expect(returned).toMatch(UUID_V4);
        } else {
          // serde's inner text is not reproducible, but the failure and its
          // `conversation:` prefix are this port's contract.
          expect(threw).toBeInstanceOf(CompactionError);
          // The Rust's variant, which the command surface branches on. Carried
          // by the class rather than recovered from the message prefix.
          expect((threw as CompactionError).kind).toBe("conversation");
          expect((threw as Error).message).toStartWith("conversation:");
          expect(c.outcome.err).toStartWith("conversation:");
        }

        const actual = await snapshot(dir);
        const expected = Object.fromEntries(
          Object.entries(c.after).map(([k, v]) => [k, b64(v)]),
        );

        // Same set of files, so a writer that stopped creating segments — or
        // started creating extra ones — fails here rather than slipping past.
        expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());

        for (const [rel, want] of Object.entries(expected)) {
          const got = actual[rel]!;
          if (rel === "compaction.json") {
            expect(normalizeManifest(got, seeded)).toBe(
              normalizeManifest(want, seeded),
            );
          } else {
            expect(got).toBe(want);
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
