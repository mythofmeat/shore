# Persistent storage

Shore keeps durable daemon state in the XDG data directory:

```text
shore.db
media/
  <character>/
    attachments/
    generated/
```

`shore.db` holds conversation history, active conversations and thread indexes,
usage accounting, captured API requests and responses, heartbeat events,
subagent traces, frozen prompt snapshots, autonomy scheduling state, Matrix
bindings and preferences, and Agent SDK session records. SQLite may also create
`shore.db-wal` and `shore.db-shm` while the database is open.

These records have different schemas but share one database. Usage accounting
uses the ledger tables, conversation archives use `history_*`, captured API
traffic uses `capture_*`, durable state uses `state_files`, and heartbeat and
subagent diagnostics use indexed `events` rows. State and diagnostic event
contents are Zstandard compressed; captured payloads use compressed,
content-addressed chunks to share repeated data.

Usage records whose model has no catalog price retain an unknown cost. They
remain visible as unpriced calls even after the provider is removed from the
configuration. Automatic cost backfill runs at startup and every six hours.
Successful pricing catalog checks are recorded in `pricing_catalog_checks` and
reused for 24 hours, so missing or retired models share one lookup across daemon
restarts. Missing entries do not produce repeated startup warnings. Failed
catalog requests still warn and remain retryable; a later successful lookup
can price the original records without deleting or reclassifying them.

The daemon expires diagnostics older than 30 days at startup and once every
24 hours. This removes raw API/HTTP captures, diagnostic transcripts, and
heartbeat log events. Subagent intermediate messages expire on the same
schedule, while results, errors, timestamps, model names, and parent-call links
remain indefinitely. These result records remain queryable as subagent traces
with empty `messages` and `messages_expired: true`.

Shore mirrors new SDK sessions into the database so its retention policy does
not depend on the SDK's separate local-file cleanup. Existing sessions without
a mirror are rebuilt from Shore history on their next use.
Claude Agent SDK history uses native user and assistant messages, preserving
tool calls and their associated results. A failure to restore that history
stops the request; Shore never falls back to a transcript embedded in user text.
SDK sessions are retired when compaction or clearing replaces a thread's active
conversation, or when another SDK session replaces them. Retired sessions keep
their compressed database mirrors and local SDK transcript files for 30 days
from retirement. The daily sweep then removes both copies, including SDK
subagent transcript directories. Sessions referenced by an active thread,
including parent sessions needed for regeneration, remain protected regardless
of age. Reactivating a session cancels retirement. Unreferenced database mirrors
discovered by the sweep receive a fresh 30-day grace period. Local files without
a known Shore session ID are left to the SDK's own cleanup policy. The SDK may
remove its local files earlier; the database mirror preserves the diagnostic
copy for the full retirement period.

Main conversation history and alternatives, memory and active session state,
and usage accounting do not expire. Malformed subagent records and records without a valid
age are preserved for inspection. Capture cleanup reclaims only payloads and
chunks no longer referenced by retained captures. Freed pages can be reused by
new records; daily cleanup does not run a full `VACUUM`. There is no total-size
ceiling, and existing per-payload capture limits still apply. Existing backups
are not pruned by this policy. Routine conversation recovery backups retain eight copies;
quarantined malformed lines are excluded from that limit. Explicit character
deletion removes that character's records and media.

The cache directory holds rebuildable material such as search indexes and
thumbnails. Frozen prompts and autonomy state remain durable: losing them can
change a resumed conversation or its scheduling. CLI selection/preferences and
legacy thread-directory scaffolding may still appear under data.

Hindsight integration, including automatic recall and background retention, has
been removed. Delete `[memory.backend]`, `[memory.recall]`, and `[memory.retain]`
from configuration; these sections now produce an explicit configuration error.
The obsolete `trace recall` and `segments retry` commands are also removed.
Database migration drops Hindsight bookkeeping while keeping conversation
history and compaction coverage. Local Markdown memory and history search
remain available.

## Migration

On startup, after the daemon acquires exclusive ownership of its data directory,
Shore imports the old data/history.db, data/ledger.db, cache/ledger.db,
cache/calls.db and data/calls.db stores. It snapshots SQLite including WAL data,
checks database integrity, imports transactionally, and retires each source only
after its import commits. Duplicate copies are merged without duplicating their
shared rows; repeated records within a source remain repeated. Conflicting
natural-key rows are retained as compressed `legacy/conflicts/` state records.
Malformed or unrecognized databases stop migration and remain available for
inspection. Interrupted imports can be retried by restarting.

History upgrades remove the obsolete `memory_retain` column and
`history_memory_retain` queue; current retention settings and document state are
preserved. Archive imports also omit the retired column. Zero-byte legacy
database files are retired only when their WAL, shared-memory, and rollback
journal files are absent or empty; nonempty sidecars stop migration for inspection.

Import deduplication records use a `WITHOUT ROWID` table with 32-byte binary
SHA-256 digests. Existing hexadecimal records are converted transactionally;
their occurrence counters and destination IDs are preserved. Freed database
pages remain reusable until an explicit `VACUUM` compacts the file. The daemon
does not vacuum on every startup.

Recognized JSON state and JSONL logs move into the database. Legacy logs are
streamed in batches, including malformed nonempty lines retained for diagnosis.
Unknown files are left in place. Existing images move to `media/<character>/`;
compatibility links preserve old absolute references. Filename conflicts retain
both originals. There is no image browser, media expiry, or new reattachment
UI in this change.

## Character archives and backups

Version 2 character exports include that character's database records,
diagnostics, workspace, configuration and media. Imports relocate stored image
references and native session keys to the destination data directory. Other
characters' records and global connection state are excluded. Version 1 archives
remain importable.

Back up both the database and `media/`. For a whole-installation backup, stop the
daemon before copying the data directory, or use SQLite's backup facilities for
the database; copying only `shore.db` while it is open can omit WAL changes.
