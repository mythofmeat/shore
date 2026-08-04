#!/usr/bin/env python3
"""Mutation pass over the observability call store (#18 / #12).

The store is a write-then-read module with no user-facing errors, so its
failure modes are all silent ones. What the fixture has to catch:

- **Reading the wrong column.** Fourteen columns of three types, several
  interchangeable — swap `input_tokens` for `output_tokens`, or `model` for
  `provider`, and every row still looks like a row.
- **Ordering.** `ORDER BY ts_unix DESC, id DESC` is two keys, and dropping
  either one is invisible until two rows share a timestamp. `call_log` shows
  the result as "recent calls", so a wrong order is a wrong answer.
- **Losing a filter.** A `character` filter that silently matches everything
  leaks one character's calls into another's log.
- **`limit == 0` meaning "no limit".** Spelled `-1` to SQLite. Pass the 0
  through and every unlimited query returns nothing.
- **Rotation deleting the wrong rows.** The size backstop is a window function
  with an exclusion for the newest row; get the exclusion wrong and rotation
  can empty the store. Get the comparison wrong and it never fires.
- **The migration.** A DB predating `transcripts.character` must gain the
  column. Skip it and every transcript write against an old store fails.

A mutant is KILLED if `bun test tests/call_store_parity.test.ts` fails with it
applied.

This is **60/60**, from 54/63 on the first pass. Of the nine that lived:

- **One was a real bug.** The stored `ts` string is `to_rfc3339`, which prints
  the sub-second fraction when it is non-zero. The port dropped the fraction
  unconditionally — and since every recorded call takes its timestamp from
  `Utc::now()`, that was every row in the store, not an edge case. The fixture
  had not caught it because every timestamp in it was a whole second.
- **Four were fixture gaps**, all closed by two additions: a call written last
  but stamped three-quarters of a second into an earlier row's second, and a
  transcript whose `call_type` differs from its `source`. Before those, id
  order and timestamp order agreed, and `source` and `call_type` held the same
  string in every row, so swapping either pair changed nothing.
- **Three were bad mutants** — one no-op, one whose pattern never matched, and
  one that read the SQLite change count a statement later, which reads the same
  value. Rewritten or dropped.
- **One killed its own code.** `cap()` clamped the size cap into the
  safe-integer range, mirroring a `u64`-to-`i64` saturation that only exists
  because Rust's types demand it. Nothing could reach it and no fixture could
  express it, so it is gone rather than tested.

One further mutant is **removed as equivalent**, not chased: dropping the
`id DESC` tiebreak from the calls query. Two rows share a timestamp, a call
type and a character precisely so the tiebreak decides between them — but every
plan SQLite picks for these queries already walks the index in descending rowid
order, so the tiebreak and its absence are indistinguishable. It stays in the
SQL because relying on the plan is not a contract, and that is written down at
the query rather than left to be rediscovered.

The fixture is built to make the rest visible. It is not a JSON transcript of
Rust's answers — it ships whole SQLite files that Rust *wrote*, and the replay
queries those exact bytes. That is what makes byte counts and eviction
boundaries assertable at all: Rust and Bun link different libzstd builds and
disagree on the compressed size of some payloads, so asking TypeScript to
reproduce Rust's numbers would pin a library version rather than this module.
One call has every optional column null; one has a response body and one has
none, so `null` and `""` are told apart; one transcript entry is not valid
JSON, so the parse fallback is exercised rather than assumed.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_call_store.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/call_store.ts"

# (label, find, replace)
MUTANTS = [
    # --- ordering -------------------------------------------------------------
    ("calls: ordered oldest-first",
     "         ORDER BY ts_unix DESC, id DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))",
     "         ORDER BY ts_unix ASC, id ASC\n         LIMIT ?3`,\n      )\n"
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))"),
    ("calls: the id tiebreak runs the other way",
     "         ORDER BY ts_unix DESC, id DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))",
     "         ORDER BY ts_unix DESC, id ASC\n         LIMIT ?3`,\n      )\n"
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))"),
    ("calls: ordered by id rather than by timestamp",
     "         ORDER BY ts_unix DESC, id DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))",
     "         ORDER BY id DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))"),
    ("transcripts: ordered oldest-first",
     "         ORDER BY ts_unix DESC, id DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(source, opt(character), bound(limit))",
     "         ORDER BY ts_unix ASC, id ASC\n         LIMIT ?3`,\n      )\n"
     "      .all(source, opt(character), bound(limit))"),
    ("transcripts: the id tiebreak is dropped",
     "         ORDER BY ts_unix DESC, id DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(source, opt(character), bound(limit))",
     "         ORDER BY ts_unix DESC\n         LIMIT ?3`,\n      )\n"
     "      .all(source, opt(character), bound(limit))"),

    # --- filters --------------------------------------------------------------
    ("calls: the call_type filter matches everything",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n           AND (?2 IS NULL OR character = ?2)",
     "         WHERE (?1 IS NULL OR ?1 = ?1)\n           AND (?2 IS NULL OR character = ?2)"),
    ("calls: the character filter matches everything",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n           AND (?2 IS NULL OR character = ?2)",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n           AND (?2 IS NULL OR ?2 = ?2)"),
    ("calls: the two filters are swapped",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n           AND (?2 IS NULL OR character = ?2)",
     "         WHERE (?1 IS NULL OR character = ?1)\n           AND (?2 IS NULL OR call_type = ?2)"),
    ("calls: the filters are OR'd rather than AND'd",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n           AND (?2 IS NULL OR character = ?2)",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n            OR (?2 IS NULL OR character = ?2)"),
    ("calls: an explicit null filter matches nothing rather than everything",
     "         WHERE (?1 IS NULL OR call_type = ?1)\n           AND (?2 IS NULL OR character = ?2)",
     "         WHERE call_type IS ?1\n           AND (?2 IS NULL OR character = ?2)"),
    ("transcripts: the source filter matches everything",
     "         WHERE source = ?1 AND (?2 IS NULL OR character = ?2)",
     "         WHERE ?1 = ?1 AND (?2 IS NULL OR character = ?2)"),
    ("transcripts: the character filter matches everything",
     "         WHERE source = ?1 AND (?2 IS NULL OR character = ?2)",
     "         WHERE source = ?1 AND (?2 IS NULL OR ?2 = ?2)"),
    ("transcripts: a null character matches only rows with no character",
     "         WHERE source = ?1 AND (?2 IS NULL OR character = ?2)",
     "         WHERE source = ?1 AND character IS ?2"),
    ("filters: undefined is not treated as absent",
     "function opt(value: string | null | undefined): string | null {\n  return value ?? null;\n}",
     "function opt(value: string | null | undefined): string | null {\n"
     '  return value === undefined ? "" : value;\n}'),

    # --- limits ---------------------------------------------------------------
    ("limit: 0 means zero rows rather than no limit",
     "  return limit === 0 ? -1 : limit;",
     "  return limit;"),
    ("limit: every query is unlimited",
     "  return limit === 0 ? -1 : limit;",
     "  return -1;"),
    ("limit: off by one",
     "  return limit === 0 ? -1 : limit;",
     "  return limit === 0 ? -1 : limit + 1;"),
    ("limit: a negative limit is clamped to none",
     "      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit))",
     "      .all(opt(filter.call_type), opt(filter.character), Math.max(filter.limit, 1))"),

    # --- column mapping -------------------------------------------------------
    ("summary: input and output tokens are swapped",
     '    input_tokens: count(row["input_tokens"]),\n'
     '    output_tokens: count(row["output_tokens"]),',
     '    input_tokens: count(row["output_tokens"]),\n'
     '    output_tokens: count(row["input_tokens"]),'),
    ("summary: cache reads report the input count",
     '    cache_read_tokens: count(row["cache_read_tokens"]),',
     '    cache_read_tokens: count(row["input_tokens"]),'),
    ("summary: model and provider are swapped",
     '    model: optText(row["model"]),\n    provider: optText(row["provider"]),',
     '    model: optText(row["provider"]),\n    provider: optText(row["model"]),'),
    ("summary: call_id reports the row id",
     '    call_id: text(row["call_id"]),',
     '    call_id: String(row["id"]),'),
    ("summary: call_type and character are swapped",
     '    call_type: optText(row["call_type"]),\n    character: optText(row["character"]),',
     '    call_type: optText(row["character"]),\n    character: optText(row["call_type"]),'),
    ("summary: the two blob sizes are swapped",
     '    request_bytes: count(row["request_bytes"]),\n'
     '    response_bytes: count(row["response_bytes"]),',
     '    request_bytes: count(row["response_bytes"]),\n'
     '    response_bytes: count(row["request_bytes"]),'),
    ("summary: an absent duration reads as 0 rather than null",
     '    duration_ms: optCount(row["duration_ms"]),',
     '    duration_ms: count(row["duration_ms"]),'),
    ("summary: a zero duration reads as null",
     "function optCount(v: unknown): number | null {\n"
     "  return typeof v === \"number\" && Number.isFinite(v) ? Math.max(v, 0) : null;\n}",
     "function optCount(v: unknown): number | null {\n"
     "  return typeof v === \"number\" && Number.isFinite(v) && v > 0 ? v : null;\n}"),
    ("summary: an absent error reads as an empty string rather than null",
     '    error: optText(row["error"]),',
     '    error: text(row["error"]),'),
    ("payload: the two bodies are swapped",
     '      request: blobToText(row["request_zstd"]),\n'
     '      response: blobToText(row["response_zstd"]),',
     '      request: blobToText(row["response_zstd"]),\n'
     '      response: blobToText(row["request_zstd"]),'),
    ("transcript: the iteration reports the row id",
     '      iteration: count(row["iteration"]),',
     '      iteration: count(row["id"]),'),
    ("transcript: source and call_type are swapped",
     '      source: text(row["source"]),\n      character: optText(row["character"]),\n'
     '      call_type: optText(row["call_type"]),',
     '      source: text(row["call_type"]),\n      character: optText(row["character"]),\n'
     '      call_type: optText(row["source"]),'),
    ("transcript: an absent character reads as an empty string",
     '      character: optText(row["character"]),',
     '      character: text(row["character"]),'),

    # --- writing --------------------------------------------------------------
    ("write: the sort key is the wall clock rather than the record's timestamp",
     "        rfc3339(call.ts),\n        unixSeconds(call.ts),",
     "        rfc3339(call.ts),\n        unixSeconds(new Date(0)),"),
    ("write: the stored timestamp is ISO-8601 with a Z rather than an offset",
     '  return `${iso.replace(/\\.000Z$/, "").replace(/Z$/, "")}+00:00`;',
     "  return ts.toISOString();"),
    ("write: a zero fraction is printed rather than omitted",
     '  return `${iso.replace(/\\.000Z$/, "").replace(/Z$/, "")}+00:00`;',
     '  return `${iso.replace(/Z$/, "")}+00:00`;'),
    ("write: every fraction is dropped, not just the zero one",
     '  return `${iso.replace(/\\.000Z$/, "").replace(/Z$/, "")}+00:00`;',
     '  return `${iso.replace(/\\.\\d+Z$/, "").replace(/Z$/, "")}+00:00`;'),
    ("write: unix seconds round rather than truncate",
     "  return Math.floor(ts.getTime() / 1000);",
     "  return Math.round(ts.getTime() / 1000);"),
    ("write: an absent response body is stored as an empty one",
     "    const responseBlob =\n"
     "      call.response_body === undefined || call.response_body === null\n"
     "        ? null\n        : zstdCompress(call.response_body);",
     '    const responseBlob = zstdCompress(call.response_body ?? "");'),
    ("write: an empty response body is stored as absent",
     "    const responseBlob =\n"
     "      call.response_body === undefined || call.response_body === null\n"
     "        ? null\n        : zstdCompress(call.response_body);",
     "    const responseBlob = call.response_body\n"
     "      ? zstdCompress(call.response_body)\n      : null;"),
    ("write: the transcript's token counts are shifted by one column",
     "        entry.usage.input_tokens,\n        entry.usage.output_tokens,\n"
     "        entry.usage.cache_read_tokens,",
     "        entry.usage.output_tokens,\n        entry.usage.cache_read_tokens,\n"
     "        entry.usage.input_tokens,"),

    # --- compression ----------------------------------------------------------
    ("zstd: a stored blob is not decompressed before it is returned",
     '  return new TextDecoder("utf-8").decode(zstdDecompressSync(blob));',
     '  return new TextDecoder("utf-8").decode(blob);'),
    ("zstd: an absent blob decompresses to an empty string rather than null",
     "  if (!(blob instanceof Uint8Array)) return null;",
     '  if (!(blob instanceof Uint8Array)) return "";'),
    ("zstd: bodies are stored as latin-1 rather than UTF-8",
     '  return zstdCompressSync(Buffer.from(data, "utf8"), {',
     '  return zstdCompressSync(Buffer.from(data, "latin1"), {'),

    # --- the JSON fallback ----------------------------------------------------
    ("entry: an unparseable entry throws rather than coming back as text",
     "  try {\n    return JSON.parse(json);\n  } catch {\n    return json;\n  }",
     "  return JSON.parse(json);"),
    ("entry: every entry comes back as raw text",
     "  try {\n    return JSON.parse(json);\n  } catch {\n    return json;\n  }",
     "  return json;"),

    # --- rotate ---------------------------------------------------------------
    ("rotate: the cutoff is inclusive",
     '    const agedCalls = this.#changes("DELETE FROM calls WHERE ts_unix < ?1", cutoffUnix);',
     '    const agedCalls = this.#changes("DELETE FROM calls WHERE ts_unix <= ?1", cutoffUnix);'),
    ("rotate: transcripts are not pruned by age",
     "    const agedTranscripts = this.#changes(\n"
     '      "DELETE FROM transcripts WHERE ts_unix < ?1",\n      cutoffUnix,\n    );',
     "    const agedTranscripts = 0;"),
    ("rotate: the age counter omits transcripts",
     "      deleted_by_age: agedCalls + agedTranscripts,",
     "      deleted_by_age: agedCalls,"),
    ("rotate: the two counters are swapped",
     "      deleted_by_age: agedCalls + agedTranscripts,\n      deleted_by_size: sized,",
     "      deleted_by_age: sized,\n      deleted_by_size: agedCalls + agedTranscripts,"),
    ("rotate: the size backstop keeps the oldest rows rather than the newest",
     "                          OVER (ORDER BY ts_unix DESC, id DESC",
     "                          OVER (ORDER BY ts_unix ASC, id ASC"),
    ("rotate: the running total is at-or-over rather than over the cap",
     "           WHERE running > ?1",
     "           WHERE running >= ?1"),
    ("rotate: the newest row is not exempt from the cap",
     "           WHERE running > ?1\n"
     "             AND id != (SELECT id FROM calls ORDER BY ts_unix DESC, id DESC LIMIT 1)",
     "           WHERE running > ?1"),
    ("rotate: the exempt row is the oldest rather than the newest",
     "             AND id != (SELECT id FROM calls ORDER BY ts_unix DESC, id DESC LIMIT 1)",
     "             AND id != (SELECT id FROM calls ORDER BY ts_unix ASC, id ASC LIMIT 1)"),
    ("rotate: the running total counts only the request blob",
     "                      SUM(COALESCE(LENGTH(request_zstd), 0) + COALESCE(LENGTH(response_zstd), 0))",
     "                      SUM(COALESCE(LENGTH(request_zstd), 0))"),
    ("rotate: the size backstop is skipped entirely",
     "    const sized = this.#changes(\n      `DELETE FROM calls WHERE id IN (",
     "    const sized = this.#changes(\n      `DELETE FROM calls WHERE 0 AND id IN ("),

    # --- schema and migration -------------------------------------------------
    ("migrate: an old DB never gains transcripts.character",
     '  if (!columnExists(db, "transcripts", "character")) {',
     "  if (false) {"),
    ("migrate: the migration runs on every open",
     '  if (!columnExists(db, "transcripts", "character")) {',
     "  if (true) {"),
    ("migrate: the covering index is left at its old shape",
     "      `ALTER TABLE transcripts ADD COLUMN character TEXT;\n"
     "       DROP INDEX IF EXISTS idx_transcripts_source;\n"
     "       CREATE INDEX idx_transcripts_source\n"
     "           ON transcripts (source, character, ts_unix);`,",
     "      `ALTER TABLE transcripts ADD COLUMN character TEXT;`,"),
    ("migrate: the column check reads the wrong table",
     '  if (!columnExists(db, "transcripts", "character")) {',
     '  if (!columnExists(db, "calls", "character")) {'),
    ("schema: the transcript index omits the character",
     "CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts (source, character, ts_unix);",
     "CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts (source, ts_unix);"),
    ("schema: a fresh DB has no character column",
     "    source            TEXT NOT NULL,\n    character         TEXT,\n    call_type         TEXT,",
     "    source            TEXT NOT NULL,\n    call_type         TEXT,"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/call_store_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = SRC.read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        SRC.write_text(original.replace(find, replace, 1))
        killed = not run()
        SRC.write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    SRC.write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
