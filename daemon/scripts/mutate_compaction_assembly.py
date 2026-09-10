#!/usr/bin/env python3
"""Mutation pass over the compaction assembly (#18 / #12).

Two kinds of code here, and the mutants are aimed differently at each.

`archiveAndRetain` is the one part of a compaction pass that writes to disk
without going through the pass: it splits `active.jsonl`, appends a numbered
segment, updates the manifest, and rewrites what is left. Every arithmetic
mistake in it is silent and permanent — a split off by one archives a turn the
model was told would be kept, and a segment index that reuses a number
overwrites history. So most of the mutants are the off-by-ones.

The rest resolve things, and there the failure mode is a fallback that fires
when it should not: a template default that wins over a character's override,
a model that is chosen instead of refused.

A mutant is KILLED if `bun test tests/compaction_assembly.test.ts` fails
with it applied.

This is **17/17**, from 14/17 on the first pass.

Three survivors, all of them the recorded cases being too forgiving:

- **The clamp.** `keep_last_n = 99` against three lines: an unclamped
  subtraction goes to −96, and JavaScript's negative `slice` bounds happen to
  produce the right two halves. One past the end — `4` against three — is where
  it actually goes wrong, and that case now exists.
- **The retained file's shape, twice.** The replay compared the messages it
  parsed back, so a blank line and a missing trailing newline were both
  invisible. The fixture records the exact bytes now, which is the right level
  for a file another process reads.

Run from the repository root:
    python3 daemon/scripts/mutate_compaction_assembly.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
A = "src/memory/compaction/archive.ts"
R = "src/memory/compaction/run.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the split ------------------------------------------------------------
    ("split: keeps one too many",
     A,
     "  const keep = Math.min(keepLastN, lines.length);",
     "  const keep = Math.min(keepLastN + 1, lines.length);"),
    ("split: keeps one too few",
     A,
     "  const keep = Math.min(keepLastN, lines.length);",
     "  const keep = Math.max(0, Math.min(keepLastN, lines.length) - 1);"),
    ("split: the keep count is not clamped to what exists",
     A,
     "  const keep = Math.min(keepLastN, lines.length);",
     "  const keep = keepLastN;"),
    ("split: the halves are swapped",
     A,
     '\n    const archived = lines.slice(0, splitAt);\n    const retained = lines.slice(splitAt);',
     '  const archived = lines.slice(splitAt);\n    const retained = lines.slice(0, splitAt);'),
    ("split: blank lines count as messages",
     A,
     '  const lines = rustLines(activeContent).filter((l) => rustTrim(l) !== "");',
     "  const lines = rustLines(activeContent);"),
    ("split: the tail is kept from the front of the conversation",
     A,
     "  const splitAt = lines.length - keep;",
     "  const splitAt = keep;"),

    # --- the segment ----------------------------------------------------------
    ("segment: the index starts at zero",
     A,
     "  const segmentIndex = manifest.segments.length + 1;",
     "  const segmentIndex = manifest.segments.length;"),
    ("segment: the index ignores what is already in the manifest",
     A,
     "  const segmentIndex = manifest.segments.length + 1;",
     "  const segmentIndex = 1;"),
    ("segment: the file name is not zero-padded",
     A,
     '  const segmentFile = `${String(segmentIndex).padStart(4, "0")}.jsonl`;',
     "  const segmentFile = `${segmentIndex}.jsonl`;"),
    ("segment: an empty archive still writes one",
     A,
     '\n\n    if (archived.length > 0) {\n      await writeSegment(characterDir, archived, now, operationId);\n    }',
     '  await writeSegment(characterDir, archived, now, operationId);'),
    ("segment: the manifest's running total is not updated",
     A,
     "  manifest.total_compacted_messages += archived.length;",
     ""),
    ("segment: the manifest records the wrong count",
     A,
     "    message_count: archived.length,",
     "    message_count: 0,"),
    ("segment: an existing manifest is replaced rather than appended to",
     A,
     "    parsed = JSON.parse(raw) as Partial<CompactionManifest>;",
     "    parsed = { segments: [], total_compacted_messages: 0 };\n    void raw;"),

    # --- the retained write ---------------------------------------------------
    ("retained: an empty conversation is written as a blank line",
     A,
     '  const retainedContent = retained.length === 0 ? "" : retained.join("\\n") + "\\n";',
     '  const retainedContent = retained.join("\\n") + "\\n";'),
    ("retained: the trailing newline is dropped",
     A,
     '  const retainedContent = retained.length === 0 ? "" : retained.join("\\n") + "\\n";',
     '  const retainedContent = retained.length === 0 ? "" : retained.join("\\n");'),

    # --- the rendering --------------------------------------------------------
    ("render: a string result is serialized like everything else",
     R,
     "    return { output: renderToolValue(value), isError: false };",
     '    return { output: JSON.stringify(value) ?? "", isError: false };'),
    ("render: a failure is stringified rather than read for its message",
     R,
     "    return { output: e instanceof Error ? e.message : String(e), isError: true };",
     "    return { output: String(e), isError: true };"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/compaction_assembly.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
