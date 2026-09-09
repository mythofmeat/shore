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

Diagnostics have no automatic age or total-size expiry. The daemon no longer
runs the old 14-day/512-MiB purge. Heartbeat display keeps a small in-memory
window, while the database retains older events. Existing per-payload capture
limits still apply. Routine conversation recovery backups retain eight copies;
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

Recognized JSON state and JSONL logs move into the database. Legacy logs are
streamed in batches, including malformed nonempty lines retained for diagnosis.
Unknown files are left in place. Existing images move to `media/<character>/`;
compatibility links preserve old absolute references. Filename conflicts retain
both originals. There is no image browser, retention policy, or new reattachment
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
