/**
 * A real `ledger.db`.
 *
 * It used to be created by booting the daemon binary, because the whole
 * arrangement rested on Rust owning the schema and this side writing into it —
 * a test that made its own tables would have proved nothing about the pair.
 * That is no longer the arrangement: `Ledger.create` carries the schema and the
 * migrations now (see `ledger/store.ts`), so creating one here *is* exercising
 * production's own author rather than a copy of it.
 *
 * Two things went away with the daemon. Every suite that used this was gated on
 * a `haveDaemon` check, so 32 tests silently skipped on any checkout without a
 * debug build — and ran against a stale binary on one that had an old build
 * lying around, which is the same skew that bites at runtime. And each fixture
 * cost a process spawn plus up to 20 seconds of polling.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../../src/ledger/store.ts";

export interface LedgerFixture {
  path: string;
  cleanup: () => void;
}

/** A ledger with production's schema on it, and nothing in it. */
export function freshLedger(): LedgerFixture {
  const root = mkdtempSync(join(tmpdir(), "shore-ledger-"));
  const path = join(root, "ledger.db");
  Ledger.create(path).close();
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Open a ledger the way production does — with a busy timeout.
 *
 * `Ledger.open` sets `busy_timeout = 5000` because a real daemon and a real
 * sidecar share `ledger.db`, and a reader that meets a writer mid-checkpoint
 * must wait rather than throw. Tests opening the file raw got no such grace, so
 * the suite failed intermittently with `SQLiteError: database is locked` — on a
 * different test each run, since which one lost the race depended on when the
 * daemon this fixture spawned got round to shutting down.
 *
 * The daemon is killed but not waited for, deliberately: it takes seconds to
 * checkpoint and exit, and blocking on that put every fixture over the 5s test
 * timeout. Tolerating the overlap is cheaper than serialising against it.
 */
export function openLedger(path: string, opts: { readonly?: boolean } = {}): Database {
  // `readonly` and `create` are mutually exclusive in bun:sqlite — asking for a
  // writable handle with `create: false` is rejected as API misuse rather than
  // ignored, so the two cases are opened separately.
  const db = opts.readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Every row in the ledger, oldest first. */
export function rowsIn(path: string): Array<Record<string, unknown>> {
  const db = openLedger(path, { readonly: true });
  const rows = db.query("SELECT * FROM calls ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;
  db.close();
  return rows;
}
