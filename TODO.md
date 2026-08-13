# History in the payload store

Parked work. Branch `wip/history-in-payload-store`. Delete this file when the
work lands.

## What this branch is

Move conversation history out of JSON segment files and into SQLite, sharing the
content-addressed blobs that `call_store.ts` already uses for captured API
payloads.

Two commits carry it:

- `716b35c3` exports `storeBlob` / `loadBlob` from `call_store.ts` so tables
  outside payloads can reference the same chunks.
- `e39c2ce9` adds `daemon/src/engine/history_store.ts` and the verification
  script `daemon/scripts/history_roundtrip.ts`.

The two commits it depends on, payload capture (`94a47461`) and call diffing
(`fb7e8e53`), are already on main.

## Status: works, wrong shape. Do not build on it as-is.

The round-trip gate passes. All 648 poppy segment files, 36,092 messages plus
16,135 alternatives, deep-compared field-by-field against
`SegmentReader.readSegment()`, zero mismatches. Typechecks and passes
`lint:comments`, including after merging main at `06f96cf4`.

```
bun run scripts/history_roundtrip.ts <segments-dir> [db-path]
```

It is still the rejected design. `history_store.ts` owns message bodies in its
own blobs, so conversation text is stored twice: once as history bodies, once as
wire chunks, and the two never hash-match.

## The shape to build instead

Payload chunks are canonical. `history_messages` indexes those chunks and stores
only what the wire does not carry: `msg_id`, `role`, `timestamp`, `model`,
`origin`, `alt_index` / `alt_count`, `sdk`.

- Pre-capture history is synthesized into basic SDK-shaped chunks, so the read
  path stays uniform across both eras.
- Unselected alternatives keep their own blobs. They were never sent, so no wire
  chunk exists for them.
- `message.content` must not be stored. It is derivable from `content_blocks`
  for all 52,227 bodies checked.

## Blockers to clear first

Both are still open on main as of the merge at `06f96cf4`.

1. **`calls.db` rotation has to be off before history depends on the store.**
   `CALL_STORE_RETENTION_DAYS = 14` at `daemon/src/runtime.ts:31`, swept hourly,
   capped at 512 MB, living in the cache dir. That rotation is why captured
   payloads only reach back 13 days. `openCallStore` also returns `undefined` on
   failure, which a history read path cannot treat as "no history".
2. **`collectGarbage` in `call_store.ts` builds `live_hashes` from payload
   manifests only.** Any table sharing blobs must contribute its hashes or the
   first sweep deletes them.

## Measurements already taken

Do not re-derive these.

- History is 100% contained in captured payloads where capture ran. Window
  2026-07-30..08-06: 425 text blocks, 425 found, zero misses. The earlier "6.5%
  duplicate" figure was intra-corpus and is not the relevant number.
- Payload chunks are 97.7% duplicate. 84,668 instances collapse to 1,948
  distinct; 106.7 MB of whole-payload zstd becomes 5.7 MB chunked.
- Wire variants inflate that. Over the same window, 1,766 distinct message
  chunks hold only 1,064 distinct normalized texts, roughly 1.7x, from provider
  shape differences, `cache_control` markers, and an injected
  `[Weekday date time]` prefix on user turns. Matching history to chunks has to
  normalize, not compare raw bytes.
- `data/archive` is not segments. It is the raw source the segment backfill was
  generated from, and 24,994 of its messages have no `msg_id`. Leave it alone.

## Picking it back up

1. Clear blocker 1: make retention configurable and default it off, or move the
   history-bearing tables out of the rotated database.
2. Clear blocker 2: have `collectGarbage` collect hashes from every table that
   references blobs, not just payload manifests.
3. Rewrite `history_store.ts` to the inverse shape above.
4. Re-run the round-trip gate. It is the acceptance test and it should stay at
   zero mismatches.
