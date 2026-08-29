"""Import shore's archived conversations into a hindsight memory bank.

One archived segment becomes one hindsight document. The document id is derived
from the segment, so a rerun upserts rather than duplicating: there is no cursor
to corrupt and no resume state to keep. Re-running the whole range is safe and
is the recovery path for any failure.
"""

import argparse
import json
import sqlite3
import sys
import time

import zstandard
from hindsight_client import Hindsight

CONTEXT = (
    "A private conversation between {user} and {character}, {pronoun} partner. "
    "Constant teasing, insults, mock-outrage and running jokes are how they show "
    "affection -- an insult is a joke, not a description, and a nickname is not a "
    "fact about anyone. Record what each of them states about their own life, plans "
    "and feelings, attributing it to whichever of them said it. Never convert banter, "
    "hypotheticals, or things they imagine or roleplay into biography. "
    "This session took place from {first} to {last}."
)


def segments(db, character, since, limit):
    rows = db.execute(
        """SELECT idx, message_count FROM history_segments
            WHERE character = ? AND committed = 1 AND excluded = 0 AND message_count > 0
            ORDER BY idx DESC""",
        (character,),
    ).fetchall()
    out = []
    for idx, count in rows:
        if len(out) == limit:
            break
        out.append((idx, count))
    return out


def document(db, character, segment, user, char_label):
    rows = db.execute(
        """SELECT m.role, m.timestamp, b.data, b.compressed
             FROM history_messages m
             JOIN history_blobs b ON b.hash = m.blocks_hash
            WHERE m.character = ? AND m.segment = ?
            ORDER BY m.ordinal""",
        (character, segment),
    ).fetchall()
    decompressor = zstandard.ZstdDecompressor()
    names = {"user": user, "assistant": char_label}
    lines, stamps = [], []
    for role, timestamp, data, compressed in rows:
        if role == "system":
            continue
        raw = decompressor.decompress(data) if compressed else data
        text = " ".join(
            block.get("text", "") for block in json.loads(raw) if isinstance(block, dict)
        ).strip()
        if not text:
            continue
        stamps.append(timestamp)
        lines.append(f"{names.get(role, role)} ({timestamp}): {text}")
    return "\n\n".join(lines), stamps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", required=True, help="path to shore's history.db")
    parser.add_argument("--character", required=True, help="shore character, also the bank id")
    parser.add_argument("--user", default="the user", help="name to label user turns with")
    parser.add_argument("--pronoun", default="their", help="possessive pronoun for the character")
    parser.add_argument("--url", default="http://127.0.0.1:8888", help="hindsight base url")
    parser.add_argument("--since", default="", help="oldest date to import, YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=1, help="how many segments to import")
    parser.add_argument("--dry-run", action="store_true", help="list the work, make no calls")
    args = parser.parse_args()

    db = sqlite3.connect(f"file:{args.history}?mode=ro", uri=True)
    try:
        planned = segments(db, args.character, args.since, args.limit)
        if not planned:
            print("nothing to import")
            return 0

        client = None if args.dry_run else Hindsight(base_url=args.url, timeout=1800.0)
        for segment, count in planned:
            content, stamps = document(db, args.character, segment, args.user, args.character)
            if not content:
                print(f"seg{segment}: empty, skipped")
                continue
            first, last = stamps[0][:10], stamps[-1][:10]
            if args.since and last < args.since:
                print(f"seg{segment}: ends {last}, before --since {args.since}, stopping")
                break
            if args.dry_run:
                print(f"seg{segment}: {len(stamps)} turns, {len(content)} chars, {first}..{last}")
                continue
            started = time.time()
            client.retain(
                bank_id=args.character,
                content=content,
                context=CONTEXT.format(
                    user=args.user, character=args.character,
                    pronoun=args.pronoun, first=first, last=last,
                ),
                document_id=f"shore:{args.character}:seg{segment}",
                update_mode="replace",
            )
            print(
                f"seg{segment}: {len(stamps)} turns, {len(content)} chars, "
                f"{first}..{last}, {time.time() - started:.0f}s",
                flush=True,
            )
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
