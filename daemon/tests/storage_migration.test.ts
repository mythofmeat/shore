import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { Ledger } from "../src/ledger/store.ts";
import { migrateDatabases } from "../src/storage/migrate.ts";
import { preparePersistentStorage } from "../src/storage/prepare.ts";
import { databasePath, readCharacterState, readEvents, withStorage } from "../src/storage/store.ts";
import { appendSubagentTrace, readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { HeartbeatLog } from "../src/autonomy/heartbeat_log.ts";
import { migrateCharacterMedia } from "../src/storage/media.ts";
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
function tableNames(path: string) {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name); }
  finally { db.close(); }
}

test("both call databases merge without ID collisions or duplicated captures, and restart is idempotent", () => {
  const paths = dirs();
  capture(join(paths.cache, "calls.db"), "shared", "cache-only");
  capture(join(paths.data, "calls.db"), "shared", "data-only");
  Ledger.create(join(paths.data, "ledger.db")).close();
  HistoryStore.open(join(paths.data, "history.db")).close();
  const legacy = new Database(join(paths.cache, "calls.db"));
  for (const name of ["calls", "transcripts", "http_calls", "blobs", "payloads"]) legacy.run(`ALTER TABLE capture_${name} RENAME TO ${name}`);
  legacy.close();
  migrateDatabases(paths);
  migrateDatabases(paths);
  const path = databasePath(paths.data);
  expect(tableNames(path)).toContain("calls");
  expect(tableNames(path)).toContain("capture_calls");
  expect(tableNames(path)).toContain("history_messages");
  const store = CallStore.open(path);
  try {
    expect(store.queryCalls({ limit: 0 }).map((row) => row.call_id).sort()).toEqual(["cache-only", "data-only", "shared"]);
    for (const row of store.queryCalls({ limit: 0 })) expect(store.getCall(row.id)?.request).toContain(row.call_id);
  } finally { store.close(); }
  for (const oldPath of [join(paths.cache, "calls.db"), join(paths.data, "calls.db"), join(paths.data, "ledger.db"), join(paths.data, "history.db")]) expect(existsSync(oldPath)).toBe(false);
});

test("an invalid database is preserved and migration refuses to silently discard it", () => {
  const paths = dirs();
  const legacy = join(paths.data, "ledger.db");
  writeFileSync(legacy, "not a sqlite database");
  expect(() => migrateDatabases(paths)).toThrow();
  expect(readFileSync(legacy, "utf8")).toBe("not a sqlite database");
});

test("legacy traces stream into compressed indexed records, including malformed lines, without duplication", async () => {
  const paths = dirs();
  const character = join(paths.data, "ada");
  mkdirSync(character);
  const trace = { ts: "2020", subagent: "researcher", parent_tool_use_id: "old", model: "model", messages: [], result: "repeated text ".repeat(10000) };
  writeFileSync(join(character, "subagents.jsonl"), `${JSON.stringify(trace)}\nnot json\n`);
  await appendSubagentTrace(character, { ...trace, parent_tool_use_id: "new" });
  expect((await readSubagentTraces(character, { ids: ["old"] }))[0]).toEqual(trace);
  expect((await readSubagentTraces(character, { count: 1 }))[0]?.parent_tool_use_id).toBe("new");
  expect((await readSubagentTraces(character)).length).toBe(2);
  expect(readEvents(paths.data, "ada", "legacy_invalid")).toEqual(["not json"]);
  expect(existsSync(join(character, "subagents.jsonl"))).toBe(false);
  const bytes = withStorage(paths.data, (db) => db.query("SELECT SUM(length(content)) AS bytes FROM events").get()) as { bytes: number };
  expect(bytes.bytes).toBeLessThan(10000);
});

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

test("prompt and scheduling state migrate without becoming disposable cache", async () => {
  const paths = dirs();
  const character = join(paths.data, "ada");
  mkdirSync(join(character, "active_prompt"), { recursive: true });
  writeFileSync(join(character, "active_prompt", "SOUL.md"), "frozen prompt");
  writeFileSync(join(character, "autonomy_state.json"), '{"ticks_without_user":7}');
  await preparePersistentStorage(paths);
  rmSync(paths.cache, { recursive: true });
  expect(readCharacterState(character, "active_prompt/SOUL.md")).toBe("frozen prompt");
  expect(readCharacterState(character, "autonomy_state.json")).toBe('{"ticks_without_user":7}');
  expect(existsSync(join(character, "active_prompt"))).toBe(false);
});

test("moving originals preserves old image references and recovers a missing compatibility link", () => {
  const paths = dirs();
  const old = join(paths.data, "ada", "images");
  mkdirSync(join(old, "generated"), { recursive: true });
  writeFileSync(join(old, "generated", "picture.png"), "original bytes");
  migrateCharacterMedia(paths.data, "ada");
  expect(readFileSync(join(paths.data, "media", "ada", "generated", "picture.png"), "utf8")).toBe("original bytes");
  expect(readFileSync(join(old, "generated", "picture.png"), "utf8")).toBe("original bytes");
  rmSync(old);
  migrateCharacterMedia(paths.data, "ada");
  expect(readFileSync(join(old, "generated", "picture.png"), "utf8")).toBe("original bytes");
});

test("unified exports include a character's diagnostics and state, never another character's", async () => {
  const source = dirs();
  migrateDatabases(source);
  for (const character of ["ada", "adam"]) {
    await appendSubagentTrace(join(source.data, character), { subagent: "helper", parent_tool_use_id: character, model: "model", messages: [] });
  }
  capture(databasePath(source.data), "ada-call");
  const archive = join(source.root, "export.db");
  exportUnifiedDatabase(databasePath(source.data), "ada", archive);
  const target = dirs();
  importUnifiedDatabase(databasePath(target.data), archive, "ada", source.data, target.data);
  expect(await readSubagentTraces(join(target.data, "ada"))).toHaveLength(1);
  expect(await readSubagentTraces(join(target.data, "adam"))).toEqual([]);
  const store = CallStore.open(databasePath(target.data));
  expect(store.callCount()).toBe(1);
  store.close();
});

test("migration includes uncheckpointed WAL rows and keeps repeated ledger calls", () => {
  const paths = dirs();
  const ledgerPath = join(paths.data, "ledger.db");
  const ledger = Ledger.create(ledgerPath);
  const record = { character: "ada", provider: "test", model: "test", call_type: "message", usage: { ...ZERO_USAGE, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 0 }, finish_reason: "stop", thinking_enabled: false };
  const at = () => new Date("2020-01-01");
  const attempt = ledger.beginAttempt(record, 0.25, at);
  ledger.record(record, at, attempt);
  ledger.record(record, at);
  writeFileSync(join(paths.cache, "ledger.db"), ledger.database.serialize());
  expect(existsSync(`${ledgerPath}-wal`)).toBe(true);
  migrateDatabases(paths);
  ledger.close();
  withStorage(paths.data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM calls").get()).toEqual({ n: 2 });
    expect(db.query("SELECT calls.character FROM call_attempts JOIN calls ON calls.id = call_attempts.call_id").get()).toEqual({ character: "ada" });
  });
});

test("migration retries after destination failure without retiring the source", () => {
  const paths = dirs();
  migrateDatabases(paths);
  capture(join(paths.cache, "calls.db"), "keep");
  withStorage(paths.data, (db) => db.run("CREATE TRIGGER refuse_import BEFORE INSERT ON capture_calls BEGIN SELECT RAISE(ABORT, 'disk failure'); END"));
  expect(() => migrateDatabases(paths)).toThrow("disk failure");
  expect(existsSync(join(paths.cache, "calls.db"))).toBe(true);
  withStorage(paths.data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM capture_payloads").get()).toEqual({ n: 0 });
    db.run("DROP TRIGGER refuse_import");
  });
  migrateDatabases(paths);
  const store = CallStore.open(databasePath(paths.data));
  try { expect(store.callCount()).toBe(1); } finally { store.close(); }
});

test("unrecognized tables are preserved for inspection instead of discarded", () => {
  const paths = dirs();
  const file = join(paths.cache, "calls.db");
  capture(file, "keep");
  const db = new Database(file);
  db.run("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep this too')");
  db.close();
  expect(() => migrateDatabases(paths)).toThrow("Unrecognized tables");
  expect(existsSync(file)).toBe(true);
});

test("archive import reuses shared payloads without disturbing another character's pending calls", () => {
  const source = dirs();
  migrateDatabases(source);
  capture(databasePath(source.data), "shared-payload");
  const archive = join(source.root, "export.db");
  exportUnifiedDatabase(databasePath(source.data), "ada", archive);
  const target = dirs();
  migrateDatabases(target);
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
