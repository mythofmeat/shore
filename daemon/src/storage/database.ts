import { CallStore } from "../call_store.ts";
import { HistoryStore } from "../engine/history_store.ts";
import { Ledger } from "../ledger/store.ts";
import { databasePath, openStorage } from "./store.ts";

export function initializeDatabase(data: string): void {
  openStorage(data).close();
  const path = databasePath(data);
  CallStore.open(path).close();
  Ledger.create(path, undefined, false).close();
  HistoryStore.open(path).close();
}
