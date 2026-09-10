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

The daemon expires diagnostics older than 30 days at startup and once every
24 hours. This removes raw API/HTTP captures, diagnostic transcripts, and
heartbeat log events. Subagent intermediate messages expire on the same
schedule, while results, errors, timestamps, model names, and parent-call links
remain indefinitely. These result records remain queryable as subagent traces
with empty `messages` and `messages_expired: true`.

Main conversation history and alternatives, memory and session state, and usage
accounting do not expire. Malformed subagent records and records without a valid
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
