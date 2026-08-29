"""Import a bounded slice of shore's pre-mem0 archive.

The daemon checkpoint contains an immutable activation boundary. Live ingest
only moves forward from that boundary; this importer moves backward from it, so
the two jobs cannot cover the same messages. One invocation processes at most
one mem0 batch by default and checkpoints only successful MCP calls.
"""

import argparse
import asyncio
from dataclasses import dataclass
from datetime import date
import json
import os
import sqlite3
import tempfile
import time

import zstandard
from mcp.client.client import Client

STORE = os.environ.get("MEM0_STORE", "/data")
SERVER = os.environ.get("MEM0_URL", "http://127.0.0.1:3000/mcp")
STATE_VERSION = 2
CHECKPOINT_VERSION = 1


@dataclass(frozen=True, order=True)
class Position:
    segment: int
    ordinal: int

    def json(self) -> dict:
        return {"segment": self.segment, "ordinal": self.ordinal}


@dataclass(frozen=True)
class ArchivedMessage:
    position: Position
    role: str
    timestamp: str
    text: str


@dataclass(frozen=True)
class Batch:
    messages: list[ArchivedMessage]
    before: Position


def state_path() -> str:
    return os.path.join(STORE, "backfill_cursor.json")


def empty_state() -> dict:
    return {"version": STATE_VERSION, "characters": {}}


def load_state() -> dict:
    try:
        with open(state_path()) as handle:
            state = json.load(handle)
    except FileNotFoundError:
        return empty_state()
    except (OSError, ValueError) as error:
        raise RuntimeError(f"cannot read {state_path()}: {error}") from error
    if state.get("version") != STATE_VERSION or not isinstance(state.get("characters"), dict):
        raise RuntimeError(
            f"{state_path()} uses an unsafe legacy format; move it aside and start a bounded backfill"
        )
    return state


def save_state(state: dict) -> None:
    os.makedirs(STORE, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=STORE, delete=False)
    try:
        with handle:
            json.dump(state, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, state_path())
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def parse_position(value, field: str) -> Position:
    if not isinstance(value, dict):
        raise RuntimeError(f"{field} is missing or invalid")
    segment = value.get("segment")
    ordinal = value.get("ordinal")
    if not isinstance(segment, int) or not isinstance(ordinal, int):
        raise RuntimeError(f"{field} is missing or invalid")
    return Position(segment, ordinal)


def checkpoint_path(history: str, character: str, configured: str) -> str:
    if configured:
        return configured
    return os.path.join(os.path.dirname(os.path.abspath(history)), character, "mem0_cursor.json")


def load_daemon_checkpoint(path: str) -> tuple[Position, Position]:
    try:
        with open(path) as handle:
            checkpoint = json.load(handle)
    except FileNotFoundError as error:
        raise RuntimeError(
            f"daemon checkpoint not found at {path}; start the updated daemon once before backfilling"
        ) from error
    except (OSError, ValueError) as error:
        raise RuntimeError(f"cannot read daemon checkpoint {path}: {error}") from error
    if checkpoint.get("version") != CHECKPOINT_VERSION:
        raise RuntimeError(f"daemon checkpoint at {path} is not the bounded-backfill format")
    return (
        parse_position(checkpoint.get("cursor"), "daemon cursor"),
        parse_position(checkpoint.get("backfill_through"), "backfill boundary"),
    )


def character_state(state: dict, character: str, through: Position) -> dict:
    characters = state["characters"]
    saved = characters.get(character)
    if saved is None:
        saved = {"through": through.json(), "before": None}
        characters[character] = saved
        return saved
    saved_through = parse_position(saved.get("through"), f"saved boundary for {character}")
    if saved_through != through:
        raise RuntimeError(
            f"saved boundary for {character} is {saved_through}, daemon reports {through}; refusing overlap"
        )
    if saved.get("before") is not None:
        parse_position(saved.get("before"), f"saved cursor for {character}")
    return saved


def text_of(blob: bytes, size: int, compressed: int) -> str:
    raw = zstandard.ZstdDecompressor().decompress(blob) if compressed else blob
    if len(raw) != size:
        raise ValueError(f"decoded {len(raw)} bytes, expected {size}")
    blocks = json.loads(raw.decode("utf-8"))
    parts = [block.get("text", "") for block in blocks if block.get("type") == "text"]
    return "\n".join(part for part in parts if part).strip()


def read_messages(
    history: str,
    character: str,
    through: Position,
    before: Position | None,
    since: str,
    limit: int,
) -> list[ArchivedMessage]:
    clauses = [
        "m.character = ?",
        "s.committed = 1",
        "s.excluded = 0",
        "(m.segment < ? OR (m.segment = ? AND m.ordinal <= ?))",
    ]
    params: list = [character, through.segment, through.segment, through.ordinal]
    if before is not None:
        clauses.append("(m.segment < ? OR (m.segment = ? AND m.ordinal < ?))")
        params.extend([before.segment, before.segment, before.ordinal])
    if since:
        clauses.append("substr(m.timestamp, 1, 10) >= ?")
        params.append(since)
    params.append(limit)

    db = sqlite3.connect(f"file:{history}?mode=ro", uri=True)
    try:
        rows = db.execute(
            f"""SELECT m.segment, m.ordinal, m.role, m.timestamp,
                       b.data, b.size, b.compressed
                  FROM history_messages m
                  JOIN history_blobs b ON b.hash = m.blocks_hash
                  JOIN history_segments s
                    ON s.character = m.character AND s.idx = m.segment
                 WHERE {' AND '.join(clauses)}
                 ORDER BY m.segment DESC, m.ordinal DESC
                 LIMIT ?""",
            params,
        ).fetchall()
    finally:
        db.close()

    messages = []
    for segment, ordinal, role, timestamp, data, size, compressed in rows:
        position = Position(segment, ordinal)
        try:
            body = text_of(data, size, compressed)
        except (ValueError, json.JSONDecodeError, zstandard.ZstdError) as error:
            raise RuntimeError(f"cannot decode archived message at {position}: {error}") from error
        messages.append(ArchivedMessage(position, role, timestamp, body))
    return messages


def count_remaining(
    history: str,
    character: str,
    through: Position,
    before: Position | None,
    since: str,
) -> int:
    clauses = [
        "m.character = ?",
        "s.committed = 1",
        "s.excluded = 0",
        "(m.segment < ? OR (m.segment = ? AND m.ordinal <= ?))",
    ]
    params: list = [character, through.segment, through.segment, through.ordinal]
    if before is not None:
        clauses.append("(m.segment < ? OR (m.segment = ? AND m.ordinal < ?))")
        params.extend([before.segment, before.segment, before.ordinal])
    if since:
        clauses.append("substr(m.timestamp, 1, 10) >= ?")
        params.append(since)
    db = sqlite3.connect(f"file:{history}?mode=ro", uri=True)
    try:
        row = db.execute(
            f"""SELECT COUNT(*)
                  FROM history_messages m
                  JOIN history_segments s
                    ON s.character = m.character AND s.idx = m.segment
                 WHERE {' AND '.join(clauses)}""",
            params,
        ).fetchone()
        return int(row[0])
    finally:
        db.close()


def make_batches(messages: list[ArchivedMessage], batch_size: int, maximum: int) -> list[Batch]:
    groups: list[list[ArchivedMessage]] = []
    for message in messages:
        if not groups or groups[-1][0].position.segment != message.position.segment:
            groups.append([])
        groups[-1].append(message)

    batches = []
    for group in groups:
        usable = [message for message in group if message.text]
        for start in range(0, len(usable), batch_size):
            descending = usable[start : start + batch_size]
            batches.append(Batch(list(reversed(descending)), descending[-1].position))
            if len(batches) == maximum:
                return batches
    return batches


def add_result(result) -> tuple[int, list[str]]:
    if getattr(result, "isError", False):
        details = " ".join(
            str(getattr(block, "text", "")) for block in getattr(result, "content", [])
        ).strip()
        raise RuntimeError(details or "MCP add returned an error")
    for block in result.content:
        text = getattr(block, "text", None)
        if text:
            try:
                parsed = json.loads(text)
                added = int(parsed.get("added", 0))
                memories = parsed.get("memories", [])
                if not isinstance(memories, list) or not all(
                    isinstance(memory, str) for memory in memories
                ):
                    raise TypeError("memories must be a list of strings")
                return added, memories
            except (ValueError, AttributeError, TypeError):
                raise RuntimeError(f"MCP add returned an invalid result: {text[:200]}")
    raise RuntimeError("MCP add returned no result")


async def ingest(
    client,
    character: str,
    batches: list[Batch],
    state: dict,
    saved: dict,
) -> None:
    total_added = 0
    for index, batch in enumerate(batches, start=1):
        payload = [
            {
                "role": message.role,
                "content": f"[{message.timestamp[:16]}] {message.text[:4000]}",
            }
            for message in batch.messages
        ]
        started = time.monotonic()
        try:
            result = await client.call_tool(
                "add",
                {
                    "messages": payload,
                    "character": character,
                    "metadata": {
                        "ts": batch.messages[0].timestamp,
                        "segment": batch.messages[0].position.segment,
                    },
                },
            )
            added, memories = add_result(result)
        except BaseException as error:
            elapsed = time.monotonic() - started
            print(
                f"FAILED batch {index}/{len(batches)} after {elapsed:.1f}s; cursor not advanced: {error}",
                flush=True,
            )
            raise
        saved["before"] = batch.before.json()
        save_state(state)
        total_added += added
        elapsed = time.monotonic() - started
        warning = " WARNING: no memories extracted" if added == 0 else ""
        print(
            f"batch {index}/{len(batches)}: {len(batch.messages)} messages, {added} memories, "
            f"{elapsed:.1f}s; next before {batch.before.segment}:{batch.before.ordinal}{warning}",
            flush=True,
        )
        for memory in memories:
            rendered = memory.replace("\n", "\n    ")
            print(f"  + {rendered}", flush=True)
        if added > 0 and not memories:
            print("  WARNING: server returned a count but no memory text; rebuild mcp-mem0", flush=True)
    print(f"stopped after the requested {len(batches)} batch(es); {total_added} memories added")


async def reembed(client, path: str, character: str) -> None:
    with open(path) as handle:
        entries = json.load(handle)
    kept = [entry for entry in entries if entry.get("memory")]
    print(f"re-embedding {len(kept)} memories, no extraction", flush=True)
    for index, entry in enumerate(kept, start=1):
        timestamp = (entry.get("metadata") or {}).get("ts")
        await client.call_tool(
            "add",
            {
                "messages": [{"role": "user", "content": entry["memory"]}],
                "character": character,
                "infer": False,
                **({"metadata": {"ts": timestamp}} if timestamp else {}),
            },
        )
        if index % 200 == 0:
            print(f"  {index}/{len(kept)}", flush=True)


def valid_date(value: str) -> str:
    if value:
        date.fromisoformat(value)
    return value


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--character", required=True)
    parser.add_argument("--history", help="path to shore's history.db")
    parser.add_argument("--checkpoint", default="", help="daemon mem0_cursor.json path")
    parser.add_argument("--from", dest="since", default="", type=valid_date, help="oldest date")
    parser.add_argument("--batch", type=int, default=8, help="messages per extraction call")
    parser.add_argument(
        "--max-batches", type=int, default=1, help="hard mem0 batch limit for this invocation"
    )
    parser.add_argument("--status", action="store_true", help="show cursors and remaining work")
    parser.add_argument("--dry-run", action="store_true", help="show the next bounded run")
    parser.add_argument("--reembed", help="import already-extracted memories from a JSON dump")
    args = parser.parse_args()

    if args.batch < 1 or args.batch > 64:
        parser.error("--batch must be between 1 and 64")
    if args.max_batches < 1:
        parser.error("--max-batches must be at least 1")
    if args.reembed:
        async with Client(SERVER) as client:
            await reembed(client, args.reembed, args.character)
        return
    if not args.history:
        parser.error("--history is required unless --reembed is given")

    daemon_path = checkpoint_path(args.history, args.character, args.checkpoint)
    live_cursor, through = load_daemon_checkpoint(daemon_path)
    state = load_state()
    saved = character_state(state, args.character, through)
    before = (
        parse_position(saved["before"], f"saved cursor for {args.character}")
        if saved["before"] is not None
        else None
    )
    remaining = count_remaining(args.history, args.character, through, before, args.since)
    print(
        f"live cursor {live_cursor.segment}:{live_cursor.ordinal}; "
        f"historical boundary {through.segment}:{through.ordinal}; "
        f"backfill before {before.segment if before else '-'}:{before.ordinal if before else '-'}; "
        f"{remaining} eligible messages",
        flush=True,
    )
    if args.status:
        return
    if remaining == 0:
        print("nothing eligible to import")
        return

    scan_limit = max(args.batch * args.max_batches * 4, 64)
    messages = read_messages(
        args.history, args.character, through, before, args.since, scan_limit
    )
    batches = make_batches(messages, args.batch, args.max_batches)
    if not batches:
        if messages:
            saved["before"] = messages[-1].position.json()
            if not args.dry_run:
                save_state(state)
            print(f"skipped {len(messages)} messages with no text; no extraction calls")
        else:
            print("nothing eligible to import")
        return

    planned = sum(len(batch.messages) for batch in batches)
    print(
        f"planned: {len(batches)} mem0 batch(es), {planned} messages; "
        f"first {batches[0].messages[0].timestamp[:10]}, "
        f"last {batches[-1].messages[-1].timestamp[:10]}",
        flush=True,
    )
    if args.dry_run:
        return

    save_state(state)
    async with Client(SERVER) as client:
        await ingest(client, args.character, batches, state, saved)


if __name__ == "__main__":
    asyncio.run(main())
