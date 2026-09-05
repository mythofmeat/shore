#!/usr/bin/env python3
"""Mutation pass over segment inspection and `clear` (#12).

Every writer of a segment has keyed it on `archiveKey(character, thread)` since
stage 03 — compaction, deep archive, `clear` itself. The reader did not. So
`shore segments` in a side thread listed home's segments, `shore segments
exclude 2` excluded home's segment 2, and `clear` archived the side thread and
then reported home's last segment back as the one it had just made. None of that
throws and none of it looks wrong: the numbers are plausible, the timestamps are
real, they just belong to a different conversation.

That is the shape of every mutant here. There is no crash to catch and no error
message to match — the only evidence a test can hold is that two threads with a
segment at the same index stay told apart. So the pass wants two of them, and it
asserts on which one came back.

The second group is `clear`'s tail. Archiving under one key and reading back
under another is two separate decisions in two places, and the second one is
where the misreport lived.

A mutant is KILLED if `bun test tests/segments.test.ts` fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_segments.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SEGMENTS = ROOT / "src/commands/segments.ts"

# (label, find, replace)
MUTANTS = [
    # --- which conversation's segments these are ------------------------------
    ("scope: the reader keys on the character, so a side thread lists home's segments",
     "  const key = archiveKey(character, thread);",
     "  const key = character;"),
    ("scope: the key is built with the halves swapped",
     "  const key = archiveKey(character, thread);",
     "  const key = archiveKey(thread, character);"),
    ("scope: listing reads the character's whole history rather than this thread's",
     "      const records = store.entries(key).map(presentSegment);",
     "      const records = store.entries(character).map(presentSegment);"),
    ("scope: the listing does not say which thread it is of",
     "      return { character, thread, segments: records, count: records.length };",
     "      return { character, segments: records, count: records.length };"),
    ("scope: `show` finds the right row and then reads another thread's messages",
     "        messages: store.readSegment(key, idx),",
     "        messages: store.readSegment(character, idx),"),
    ("scope: excluding in a side thread excludes home's segment at that index",
     "        changed = store.setExcluded(key, idx, true, retainArchived);",
     "        changed = store.setExcluded(character, idx, true, retainArchived);"),
    ("scope: including in a side thread includes home's segment at that index",
     "        changed = store.setExcluded(key, idx, false, retainArchived);",
     "        changed = store.setExcluded(character, idx, false, retainArchived);"),
    ("scope: a label lands on the character's segment, not the thread's",
     '        changed = store.setLabel(key, idx, nullableText(args["value"], "label"));',
     '        changed = store.setLabel(character, idx, nullableText(args["value"], "label"));'),
    ("scope: a note lands on the character's segment, not the thread's",
     '        changed = store.setNote(key, idx, nullableText(args["value"], "note"));',
     '        changed = store.setNote(character, idx, nullableText(args["value"], "note"));'),
    ("scope: a retry re-runs hindsight against home's segment",
     "        changed = store.retryMemoryDocument(key, idx);",
     "        changed = store.retryMemoryDocument(character, idx);"),
    ("scope: the row echoed back after a mutation comes from the character",
     "    const record = store.entries(key).find((entry) => entry.idx === idx);\n"
     "    if (record === undefined) throw notFound(missing(idx, character, thread));\n"
     "    return { character, thread, action, segment: presentSegment(record) };",
     "    const record = store.entries(character).find((entry) => entry.idx === idx);\n"
     "    if (record === undefined) throw notFound(missing(idx, character, thread));\n"
     "    return { character, thread, action, segment: presentSegment(record) };"),

    # --- saying where it looked ----------------------------------------------
    ("missing: a segment absent from this thread is reported against the character",
     "  const where = thread === MAIN_THREAD ? character : `${character} thread ${thread}`;",
     "  const where = character;"),
    ("missing: home is named as a thread, so the ordinary case grows a thread it never had",
     "  const where = thread === MAIN_THREAD ? character : `${character} thread ${thread}`;",
     "  const where = `${character} thread ${thread}`;"),

    # --- clear reports what it just made -------------------------------------
    ("clear: the new segment is read back from the character, not the thread cleared",
     "      const record = store.entries(archiveKey(character, engine.thread)).at(-1);",
     "      const record = store.entries(character).at(-1);"),
    ("clear: the first segment ever made is reported instead of the newest",
     "      const record = store.entries(archiveKey(character, engine.thread)).at(-1);",
     "      const record = store.entries(archiveKey(character, engine.thread)).at(0);"),
    ("clear: the archive is written under the character, colliding with home's indices",
     "        archiveKey: archiveKey(character, engine.thread),",
     "        archiveKey: character,"),
    ("clear: the active window cleared is home's, whatever thread the session is in",
     "    const conversationDir = threadDataDir(ctx.dataDir, character, engine.thread);",
     '    const conversationDir = threadDataDir(ctx.dataDir, character, "main");'),
    ("clear: the result does not say which thread was cleared",
     "        thread: engine.thread,\n",
     ""),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/segments.test.ts"], src=SEGMENTS)


if __name__ == "__main__":
    sys.exit(main())
