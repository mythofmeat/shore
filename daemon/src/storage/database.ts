import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

import { CallStore } from "../call_store.ts";
import { HistoryStore } from "../engine/history_store.ts";
import { Ledger } from "../ledger/store.ts";
import { shoreLog } from "../log.ts";
import { databasePath, openStorage } from "./store.ts";

const INCREMENTAL = 2;
const BUSY_TIMEOUT_MS = 5000;

export function initializeDatabase(data: string): void {
  openStorage(data).close();
  const path = databasePath(data);
  CallStore.open(path).close();
  Ledger.create(path, undefined, false).close();
  HistoryStore.open(path).close();
  useIncrementalVacuum(path);
}

export function autoVacuumMode(db: Database): number {
  return (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
}

export function useIncrementalVacuum(path: string, busyTimeoutMs = BUSY_TIMEOUT_MS): boolean {
  const db = new Database(path, { readwrite: true });
  try {
    db.run(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
    if (autoVacuumMode(db) === INCREMENTAL) return false;
    const before = statSync(path).size;
    shoreLog.info(`shore: rewriting ${path} (${megabytes(before)} MB) once so that deleted rows give space back to the filesystem`);
    const started = performance.now();
    db.run("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    shoreLog.info(`shore: rewrote ${path} in ${seconds} s: ${megabytes(before)} MB -> ${megabytes(statSync(path).size)} MB`);
    return true;
  } catch (error) {
    shoreLog.warn(`shore: could not rewrite ${path}, so expired captures will not shrink it until a later start succeeds: ${String(error)}`);
    return false;
  } finally {
    db.close();
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}
