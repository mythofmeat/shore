#!/usr/bin/env python3
"""Mutation pass over shore.db giving space back to the filesystem (#288).

`CallStore` deletes expired captures and then runs `PRAGMA incremental_vacuum`,
which hands free pages back to the filesystem only in a database whose
`auto_vacuum` is INCREMENTAL. SQLite takes that mode from a database with no
tables yet, or through `VACUUM`. `openStorage` creates shore.db first and used
to leave the mode at NONE, so by the time `CallStore` asked for INCREMENTAL it
was too late, and a production shore.db stayed at its largest size.

Two things fix it, and each mutant below takes a piece of one away:

- **A new database is incremental from the start.** Every store that can
  create shore.db asks for the mode before anything else touches the file. The
  order matters: `journal_mode = WAL` writes the header of a new file, and SQLite
  ignores a later change of mode without saying so.
- **An existing database is rewritten once.** `initializeDatabase` runs
  `PRAGMA auto_vacuum = INCREMENTAL; VACUUM;` at start-up when the mode is
  anything else, logs how long that took, and truncates the write-ahead log,
  which would otherwise hold a second copy of the database for as long as
  another connection keeps it open. A rewrite that fails is logged and the
  daemon starts anyway; the next start tries again.

A mutant is KILLED if `bun test tests/storage_vacuum.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_storage_vacuum.py
"""
import sys

STORE = "src/storage/store.ts"
DATABASE = "src/storage/database.ts"
LEDGER = "src/ledger/store.ts"
CALLS = "src/call_store.ts"
HISTORY = "src/engine/history_store.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- a new database -------------------------------------------------------
    ("openStorage: a new shore.db keeps auto_vacuum NONE",
     STORE,
     "PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;",
     "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;"),
    ("openStorage: the mode is asked for after WAL has written the header",
     STORE,
     "PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;",
     "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA auto_vacuum = INCREMENTAL;"),
    ("Ledger.create: a shore.db the ledger creates keeps auto_vacuum NONE",
     LEDGER,
     '    db.run("PRAGMA auto_vacuum = INCREMENTAL;");\n    db.run("PRAGMA journal_mode = WAL;");\n',
     '    db.run("PRAGMA journal_mode = WAL;");\n'),
    ("CallStore: a shore.db the call store creates keeps auto_vacuum NONE",
     CALLS,
     "    db.run(`PRAGMA auto_vacuum = INCREMENTAL;\n             PRAGMA journal_mode = WAL;",
     "    db.run(`PRAGMA journal_mode = WAL;"),
    ("HistoryStore: a shore.db the history store creates keeps auto_vacuum NONE",
     HISTORY,
     "    db.run(`PRAGMA auto_vacuum = INCREMENTAL;\n             PRAGMA journal_mode = WAL;",
     "    db.run(`PRAGMA journal_mode = WAL;"),

    # --- an existing database -------------------------------------------------
    ("start-up: an existing database is never rewritten",
     DATABASE,
     "  HistoryStore.open(path).close();\n  useIncrementalVacuum(path);\n",
     "  HistoryStore.open(path).close();\n"),
    ("rewrite: an incremental database is rewritten on every start",
     DATABASE,
     "    if (autoVacuumMode(db) === INCREMENTAL) return false;\n",
     ""),
    ("rewrite: the mode is asked for and never applied",
     DATABASE,
     'db.run("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");',
     'db.run("PRAGMA auto_vacuum = INCREMENTAL;");'),
    ("rewrite: the database is rewritten without changing its mode",
     DATABASE,
     'db.run("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");',
     'db.run("VACUUM;");'),
    ("rewrite: the write-ahead log keeps its copy of the rewritten database",
     DATABASE,
     '    db.run("PRAGMA wal_checkpoint(TRUNCATE);");\n',
     ""),
    ("rewrite: a failed rewrite stops the daemon from starting",
     DATABASE,
     "  } catch (error) {\n    shoreLog.warn(",
     "  } catch (error) {\n    throw error;\n    shoreLog.warn("),
    ("rewrite: a failed rewrite is reported as done",
     DATABASE,
     "start succeeds: ${String(error)}`);\n    return false;",
     "start succeeds: ${String(error)}`);\n    return true;"),
]

TESTS = ["tests/storage_vacuum.test.ts"]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
