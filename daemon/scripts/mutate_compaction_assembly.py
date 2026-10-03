#!/usr/bin/env python3
"""Mutation pass over compaction assembly: splitting the conversation, writing
what is retained, and rendering the result.
"""
import sys

A = "src/memory/compaction/archive.ts"
R = "src/memory/compaction/run.ts"

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
    ("split: the keep count is not clamped to what exists (EQUIVALENT: past the "
     "end, splitAt goes negative, and slice(0, negative) and slice(negative) "
     "split the lines exactly as the clamp does)",
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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/compaction_assembly.test.ts", "tests/archive_writer.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
