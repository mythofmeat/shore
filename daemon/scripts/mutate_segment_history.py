#!/usr/bin/env python3
"""Mutation pass over reading history one segment at a time: the store's
segment lookups, bounds and ranges, how a segment is presented, and the
segment a snapshot names before the current context.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STORE = ROOT / "src/engine/history_store.ts"
READER = ROOT / "src/engine/segments.ts"
ENGINE = ROOT / "src/engine/conversation.ts"

MUTANTS = [
    # --- finding a segment and its neighbours ---------------------------------
    ("entry: a pending compaction's segment is found",
     STORE,
     "       WHERE s.character = ?1 AND s.committed = 1 ${clause}`,",
     "       WHERE s.character = ?1 ${clause}`,"),
    ("latestEntry: the oldest segment is taken for the newest",
     STORE,
     'return this.#segmentRecords("ORDER BY s.idx DESC LIMIT 1", character)[0];',
     'return this.#segmentRecords("ORDER BY s.idx LIMIT 1", character)[0];'),
    ("entryBefore: a segment counts as coming before itself",
     STORE,
     '"AND s.idx < ?2 ORDER BY s.idx DESC LIMIT 1"',
     '"AND s.idx <= ?2 ORDER BY s.idx DESC LIMIT 1"'),
    ("entryBefore: the oldest earlier segment is taken",
     STORE,
     '"AND s.idx < ?2 ORDER BY s.idx DESC LIMIT 1"',
     '"AND s.idx < ?2 ORDER BY s.idx LIMIT 1"'),
    ("entryAfter: the newest later segment is taken",
     STORE,
     '"AND s.idx > ?2 ORDER BY s.idx LIMIT 1"',
     '"AND s.idx > ?2 ORDER BY s.idx DESC LIMIT 1"'),

    # --- a segment's display range --------------------------------------------
    ("bounds: the end is the last row rather than one past it",
     STORE,
     "    return { start: row.first, end: row.last + 1 };",
     "    return { start: row.first, end: row.last };"),
    ("bounds: every segment's rows are measured together",
     STORE,
     "         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1\n"
     "           AND m.display_seq IS NOT NULL`,",
     "         WHERE m.character = ?1 AND ?2 >= 0 AND s.committed = 1\n"
     "           AND m.display_seq IS NOT NULL`,"),
    ("turns: a segment's turn count is always zero",
     STORE,
     "    return this.#committedSegmentTurnCount(character, idx);",
     "    return 0;"),

    # --- where a turn budget starts -------------------------------------------
    ("startForTurns: zero turns still reaches back one",
     STORE,
     "    if (turns <= 0) return end;",
     "    if (turns < 0) return end;"),
    ("startForTurns: the budget runs on into earlier segments",
     STORE,
     "         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1 AND m.is_user_turn = 1",
     "         WHERE m.character = ?1 AND ?2 >= 0 AND s.committed = 1 AND m.is_user_turn = 1"),
    ("startForTurns: the turn at the cursor counts as before it",
     STORE,
     "           AND m.display_seq < ?3\n         ORDER BY m.display_seq DESC",
     "           AND m.display_seq <= ?3\n         ORDER BY m.display_seq DESC"),
    ("startForTurns: one turn too many is skipped",
     STORE,
     "      .get(character, idx, end, turns - 1) as { display_seq: number } | null;",
     "      .get(character, idx, end, turns) as { display_seq: number } | null;"),

    # --- reading a range ------------------------------------------------------
    ("range: the read runs on into other segments",
     STORE,
     "         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1\n"
     "           AND m.display_seq >= ?3 AND m.display_seq < ?4",
     "         WHERE m.character = ?1 AND ?2 >= 0 AND s.committed = 1\n"
     "           AND m.display_seq >= ?3 AND m.display_seq < ?4"),
    ("range: the end of the range is read too",
     STORE,
     "           AND m.display_seq >= ?3 AND m.display_seq < ?4",
     "           AND m.display_seq >= ?3 AND m.display_seq <= ?4"),
    ("range: rows come back newest first",
     STORE,
     "         ORDER BY m.ordinal`,\n      )\n      .all(character, idx, start, end) as MessageRow[];",
     "         ORDER BY m.ordinal DESC`,\n      )\n      .all(character, idx, start, end) as MessageRow[];"),
    ("range: an empty read still reports a segment",
     STORE,
     "    metrics.segments_read = rows.length === 0 ? 0 : 1;",
     "    metrics.segments_read = 1;"),

    # --- how a segment is presented -------------------------------------------
    ("present: an excluded segment is shown as included",
     READER,
     "    excluded: record.excluded === true,",
     "    excluded: false,"),
    ("present: the label is dropped",
     READER,
     "    label: record.label ?? null,",
     "    label: null,"),
    ("present: the first and last timestamps are swapped",
     READER,
     "    first_message_at: record.first_message_at,\n"
     "    last_message_at: record.last_message_at,",
     "    first_message_at: record.last_message_at,\n"
     "    last_message_at: record.first_message_at,"),

    # --- the segment a snapshot names -----------------------------------------
    ("snapshot: the segment before the context is left off",
     ENGINE,
     "      ...(previous === undefined ? {} : { previous_segment: presentSegment(previous) }),\n",
     ""),
    ("snapshot: the oldest segment is named instead of the newest",
     ENGINE,
     "    const previous = this.#segments.latestEntry();\n    const history: History = {",
     "    const previous = this.#segments.entries()[0];\n    const history: History = {"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS,
        ["tests/history_store.test.ts", "tests/conversation.test.ts", "tests/segments.test.ts"],
    )


if __name__ == "__main__":
    sys.exit(main())
