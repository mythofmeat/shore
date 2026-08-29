"""Import shore's chat archive into mem0, a slice at a time.

Talks to the running MCP server rather than opening the store directly: embedded
Qdrant allows a single process, and the server owns it. Keeps a cursor so the
import can be run repeatedly without redoing work.
"""

import argparse
import asyncio
import json
import os
import sqlite3
import time

import zstandard
from mcp.client.client import Client

STORE = os.environ.get("MEM0_STORE", "/data")
SERVER = os.environ.get("MEM0_URL", "http://127.0.0.1:3000/mcp")


def cursor_path() -> str:
    return os.path.join(STORE, "backfill_cursor.json")


def load_cursor() -> dict:
    try:
        with open(cursor_path()) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def save_cursor(cursor: dict) -> None:
    os.makedirs(STORE, exist_ok=True)
    with open(cursor_path(), "w") as handle:
        json.dump(cursor, handle, indent=1)


def text_of(blob: bytes, size: int, compressed: int) -> str:
    raw = zstandard.ZstdDecompressor().decompress(blob) if compressed else blob
    if len(raw) != size:
        return ""
    blocks = json.loads(raw.decode("utf-8"))
    parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return "\n".join(p for p in parts if p).strip()


def read_messages(history: str, character: str, after: int, since: str, until: str) -> list:
    db = sqlite3.connect(f"file:{history}?mode=ro", uri=True)
    try:
        rows = db.execute(
            """SELECT m.id, m.role, m.timestamp, b.data, b.size, b.compressed
                 FROM history_messages m JOIN history_blobs b ON b.hash = m.blocks_hash
                WHERE m.character = ? AND m.id > ?
                ORDER BY m.segment, m.ordinal""",
            (character, after),
        ).fetchall()
    finally:
        db.close()

    out = []
    for row_id, role, timestamp, data, size, compressed in rows:
        if since and timestamp[:10] < since:
            continue
        if until and timestamp[:10] >= until:
            continue
        try:
            body = text_of(data, size, compressed)
        except (ValueError, zstandard.ZstdError):
            continue
        if body:
            out.append({"id": row_id, "role": role, "timestamp": timestamp, "text": body})
    return out


def added_count(result) -> int:
    for block in result.content:
        text = getattr(block, "text", None)
        if text:
            try:
                return int(json.loads(text).get("added", 0))
            except (ValueError, AttributeError):
                return 0
    return 0


async def ingest(client, character: str, messages: list, batch: int, workers: int) -> None:
    batches = [messages[i : i + batch] for i in range(0, len(messages), batch)]
    started = time.time()
    done = added = failed = 0
    gate = asyncio.Semaphore(workers)

    async def one(chunk):
        nonlocal done, added, failed
        payload = [
            {"role": m["role"], "content": f'[{m["timestamp"][:16]}] {m["text"][:4000]}'}
            for m in chunk
        ]
        async with gate:
            try:
                result = await client.call_tool(
                    "add",
                    {
                        "messages": payload,
                        "character": character,
                        "metadata": {"ts": chunk[0]["timestamp"]},
                    },
                )
                added += added_count(result)
            except Exception:
                failed += 1
            done += 1
            if done % 20 == 0:
                elapsed = time.time() - started
                left = elapsed / done * (len(batches) - done)
                print(
                    f"  {done}/{len(batches)} batches · {added} memories · "
                    f"{elapsed:.0f}s elapsed · ~{left:.0f}s left",
                    flush=True,
                )

    await asyncio.gather(*(one(chunk) for chunk in batches))
    print(f"{added} memories from {len(messages)} messages, {failed} failed batches", flush=True)


async def reembed(client, path: str, character: str) -> None:
    with open(path) as handle:
        entries = json.load(handle)
    kept = [e for e in entries if e.get("memory")]
    print(f"re-embedding {len(kept)} memories, no extraction", flush=True)
    for index, entry in enumerate(kept, start=1):
        ts = (entry.get("metadata") or {}).get("ts")
        await client.call_tool(
            "add",
            {
                "messages": [{"role": "user", "content": entry["memory"]}],
                "character": character,
                "infer": False,
                **({"metadata": {"ts": ts}} if ts else {}),
            },
        )
        if index % 200 == 0:
            print(f"  {index}/{len(kept)}", flush=True)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--character", required=True)
    parser.add_argument("--history", help="path to shore's history.db")
    parser.add_argument("--from", dest="since", default="", help="YYYY-MM-DD inclusive")
    parser.add_argument("--to", dest="until", default="", help="YYYY-MM-DD exclusive")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--reembed", help="import already-extracted memories from a JSON dump")
    parser.add_argument("--restart", action="store_true", help="ignore the saved cursor")
    parser.add_argument("--dry-run", action="store_true", help="report the slice, import nothing")
    args = parser.parse_args()

    if args.reembed:
        async with Client(SERVER) as client:
            await reembed(client, args.reembed, args.character)
        return

    if not args.history:
        parser.error("--history is required unless --reembed is given")

    cursor = load_cursor()
    after = 0 if args.restart else int(cursor.get(args.character, 0))
    messages = read_messages(args.history, args.character, after, args.since, args.until)
    if args.limit:
        messages = messages[: args.limit]
    if not messages:
        print("nothing to import", flush=True)
        return

    print(
        f"{len(messages)} messages, {messages[0]['timestamp'][:10]} to "
        f"{messages[-1]['timestamp'][:10]}, resuming after id {after}",
        flush=True,
    )
    if args.dry_run:
        return

    async with Client(SERVER) as client:
        await ingest(client, args.character, messages, args.batch, args.concurrency)
    cursor[args.character] = messages[-1]["id"]
    save_cursor(cursor)
    print(f"cursor saved at id {messages[-1]['id']}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
