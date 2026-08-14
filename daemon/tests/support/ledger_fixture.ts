import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../../src/ledger/store.ts";

export interface LedgerFixture {
  path: string;
  cleanup: () => void;
}

export function freshLedger(): LedgerFixture {
  const root = mkdtempSync(join(tmpdir(), "shore-ledger-"));
  const path = join(root, "ledger.db");
  Ledger.create(path).close();
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function openLedger(path: string, opts: { readonly?: boolean } = {}): Database {
  const db = opts.readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export function rowsIn(path: string): Array<Record<string, unknown>> {
  const db = openLedger(path, { readonly: true });
  const rows = db.query("SELECT * FROM calls ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;
  db.close();
  return rows;
}
