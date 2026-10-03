import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { Ledger } from "../src/ledger/store.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { databasePath, withStorage } from "../src/storage/store.ts";
import { appendSubagentTrace, readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { HeartbeatLog } from "../src/autonomy/heartbeat_log.ts";
import { exportUnifiedDatabase, importUnifiedDatabase } from "../src/storage/archive.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dirs() {
  const root = mkdtempSync(join(tmpdir(), "shore-storage-"));
  roots.push(root);
  const data = join(root, "data");
  const cache = join(root, "cache");
  mkdirSync(data); mkdirSync(cache);
  return { root, data, cache };
}
function capture(path: string, ...ids: string[]) {
  const store = CallStore.open(path);
  for (const id of ids) store.recordCall({ call_id: id, ts: new Date("2020-01-01"), character: "ada", usage: ZERO_USAGE, request_body: JSON.stringify({ id, content: "a long repeated prompt ".repeat(1000) }) });
  store.close();
}
test("heartbeat history survives beyond the in-memory window and across restarts", async () => {
  const paths = dirs();
  const file = join(paths.data, "ada", "heartbeat.jsonl");
  const log = new HeartbeatLog(file);
  for (let i = 0; i < 250; i += 1) log.push("tick_fired", String(i), "2020-01-01T00:00:00Z");
  await log.flushIfDirty();
  const restarted = await HeartbeatLog.load(file);
  expect(restarted.recent(300)).toHaveLength(250);
  expect(restarted.recent(2).map((event) => event.detail)).toEqual(["248", "249"]);
  expect(existsSync(file)).toBe(false);
});

test("unified exports include a character's diagnostics and state, never another character's", async () => {
  const source = dirs();
  initializeDatabase(source.data);
  for (const character of ["ada", "adam"]) {
    await appendSubagentTrace(join(source.data, character), { subagent: "helper", parent_tool_use_id: character, model: "model", messages: [] });
  }
  capture(databasePath(source.data), "ada-call");
  withStorage(source.data, db => {
    db.query("INSERT INTO pricing_catalog_checks (url, fetched_at) VALUES (?1, ?2)")
      .run("https://openrouter.ai/api/v1/models", Date.now());
  });
  const archive = join(source.root, "export.db");
  exportUnifiedDatabase(databasePath(source.data), "ada", archive);
  const exported = new Database(archive, { readonly: true });
  expect(exported.query("SELECT * FROM pricing_catalog_checks").all()).toEqual([]);
  exported.close();
  const target = dirs();
  importUnifiedDatabase(databasePath(target.data), archive, "ada", source.data, target.data);
  expect(await readSubagentTraces(join(target.data, "ada"))).toHaveLength(1);
  expect(await readSubagentTraces(join(target.data, "adam"))).toEqual([]);
  const store = CallStore.open(databasePath(target.data));
  expect(store.callCount()).toBe(1);
  store.close();
});

test("archive import reuses shared payloads without disturbing another character's pending calls", () => {
  const source = dirs();
  initializeDatabase(source.data);
  capture(databasePath(source.data), "shared-payload");
  const archive = join(source.root, "export.db");
  exportUnifiedDatabase(databasePath(source.data), "ada", archive);
  const target = dirs();
  initializeDatabase(target.data);
  capture(databasePath(target.data), "shared-payload");
  withStorage(target.data, (db) => db.run("UPDATE capture_calls SET character = 'bea'"));
  const ledger = Ledger.open(databasePath(target.data));
  ledger.beginAttempt({ character: "bea", provider: "test", model: "test", call_type: "message" });
  ledger.close();
  importUnifiedDatabase(databasePath(target.data), archive, "ada", source.data, target.data);
  withStorage(target.data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM capture_payloads").get()).toEqual({ n: 1 });
    expect(db.query("SELECT status FROM call_attempts WHERE character = 'bea'").get()).toEqual({ status: "pending" });
  });
  const store = CallStore.open(databasePath(target.data));
  try {
    expect(store.callCount()).toBe(2);
    for (const row of store.queryCalls({ limit: 0 })) expect(store.getCall(row.id)?.request).toContain("shared-payload");
  } finally { store.close(); }
});


test("export size is scoped to the character rather than the shared database", () => {
  const source = dirs(); initializeDatabase(source.data);
  withStorage(source.data, db => {
    db.query("INSERT INTO state_files VALUES (?1, ?2, ?3)").run("large", "other", new Uint8Array(2 * 1024 * 1024));
  });
  const archive = join(source.root, "small.db");
  expect(() => exportUnifiedDatabase(databasePath(source.data), "ada", archive, 1024 * 1024)).not.toThrow();
  const exported = new Database(archive, { readonly: true });
  try { expect(exported.query("SELECT * FROM state_files").all()).toEqual([]); } finally { exported.close(); }
  expect(() => exportUnifiedDatabase(databasePath(source.data), "other", join(source.root, "large.db"), 1024 * 1024)).toThrow("processing limit");
});

test("an archive that still carries the retired character stats table imports, and opening drops the table", () => {
  const source = dirs(); initializeDatabase(source.data);
  const archive = join(source.root, "older.db");
  withStorage(source.data, db => {
    db.run("CREATE TABLE history_character_stats (character TEXT PRIMARY KEY, display_count INTEGER NOT NULL, turn_count INTEGER NOT NULL)");
    db.query("INSERT INTO history_character_stats VALUES (?1, ?2, ?3)").run("ada", 7, 3);
    db.query("VACUUM INTO ?1").run(archive);
  });
  const older = new Database(archive, { readonly: true });
  try { expect(older.query("SELECT * FROM history_character_stats").all()).toHaveLength(1); } finally { older.close(); }
  const target = dirs();
  expect(() => importUnifiedDatabase(databasePath(target.data), archive, "ada", source.data, target.data)).not.toThrow();
  exportUnifiedDatabase(databasePath(source.data), "ada", join(source.root, "export.db"));
  for (const path of [databasePath(target.data), join(source.root, "export.db")]) {
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT name FROM sqlite_master WHERE name = 'history_character_stats'").all()).toEqual([]); } finally { db.close(); }
  }
});
