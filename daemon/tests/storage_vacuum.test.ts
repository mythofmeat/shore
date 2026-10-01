import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { Ledger } from "../src/ledger/store.ts";
import { autoVacuumMode, initializeDatabase, useIncrementalVacuum } from "../src/storage/database.ts";
import { DIAGNOSTIC_RETENTION_MS, pruneDiagnostics } from "../src/storage/retention.ts";
import { closeStorageConnections, databasePath, openStorage, STORAGE_SCHEMA, withStorage } from "../src/storage/store.ts";

const NONE = 0;
const INCREMENTAL = 2;
const now = Date.parse("2026-09-10T12:00:00Z");
const expired = new Date(now - DIAGNOSTIC_RETENTION_MS - 1000);

const roots: string[] = [];
afterEach(() => {
  closeStorageConnections();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-vacuum-"));
  roots.push(root);
  return root;
}

function modeOf(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return autoVacuumMode(db);
  } finally {
    db.close();
  }
}

function checkpointedSize(path: string): number {
  const db = new Database(path);
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  return statSync(path).size;
}

function legacyDatabase(data: string): string {
  const path = databasePath(data);
  const db = new Database(path, { create: true });
  db.run("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.run(STORAGE_SCHEMA);
  db.close();
  const store = CallStore.open(path);
  for (let i = 0; i < 20; i += 1) {
    store.recordCall({ call_id: `c${i}`, ts: expired, usage: ZERO_USAGE, request_body: randomBytes(100_000).toString("base64") });
  }
  store.close();
  return path;
}

test("each store that can create shore.db creates it with incremental auto-vacuum", () => {
  const storage = dataDir();
  openStorage(storage).close();
  expect(modeOf(databasePath(storage))).toBe(INCREMENTAL);

  for (const create of [
    (path: string) => { Ledger.create(path).close(); },
    (path: string) => { CallStore.open(path).close(); },
    (path: string) => { HistoryStore.open(path).close(); },
  ]) {
    const path = databasePath(dataDir());
    create(path);
    expect(modeOf(path)).toBe(INCREMENTAL);
  }
});

test("a database the daemon creates is incremental from the start and is never rewritten", () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    const data = dataDir();
    initializeDatabase(data);
    expect(modeOf(databasePath(data))).toBe(INCREMENTAL);
    expect(info).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

test("the store a legacy database was built with leaves it without auto-vacuum, so expiry cannot shrink it", () => {
  const data = dataDir();
  const path = legacyDatabase(data);
  expect(modeOf(path)).toBe(NONE);
  const before = checkpointedSize(path);
  expect(pruneDiagnostics(data, now).captures).toBe(20);
  expect(checkpointedSize(path)).toBe(before);
});

test("an existing database without auto-vacuum is rewritten once at start-up, and expiring captures then shrinks it", () => {
  const data = dataDir();
  const path = legacyDatabase(data);
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    initializeDatabase(data);
    expect(modeOf(path)).toBe(INCREMENTAL);
    const lines = info.mock.calls.map((call) => String(call[0]).replaceAll(path, "<db>"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^shore: rewriting <db> \(\d+\.\d MB\) once so that deleted rows give space back to the filesystem$/);
    expect(lines[1]).toMatch(/^shore: rewrote <db> in \d+\.\d s: \d+\.\d MB -> \d+\.\d MB$/);

    initializeDatabase(data);
    expect(info).toHaveBeenCalledTimes(2);
  } finally {
    info.mockRestore();
  }

  const before = checkpointedSize(path);
  expect(pruneDiagnostics(data, now).captures).toBe(20);
  expect(checkpointedSize(path)).toBeLessThan(before / 4);
});

test("the rewrite leaves no copy of the database in the write-ahead log while another connection is open", () => {
  const data = dataDir();
  const path = legacyDatabase(data);
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    withStorage(data, (db) => db.query("SELECT count(*) FROM state_files").get());
    initializeDatabase(data);
    expect(modeOf(path)).toBe(INCREMENTAL);
    expect(statSync(`${path}-wal`).size).toBe(0);
  } finally {
    info.mockRestore();
  }
});

test("a rewrite that fails is reported and leaves the database as it was for the next start to retry", () => {
  const data = dataDir();
  const path = legacyDatabase(data);
  const writer = new Database(path);
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writer.run("BEGIN IMMEDIATE;");
    expect(useIncrementalVacuum(path, 0)).toBe(false);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      `shore: could not rewrite ${path}, so expired captures will not shrink it until a later start succeeds: SQLiteError: database is locked`,
    ]);
    expect(modeOf(path)).toBe(NONE);
    writer.run("COMMIT;");
    expect(useIncrementalVacuum(path, 0)).toBe(true);
    expect(modeOf(path)).toBe(INCREMENTAL);
  } finally {
    writer.close();
    info.mockRestore();
    warn.mockRestore();
  }
});
