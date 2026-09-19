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
import { importHistoryDatabase } from "../src/commands/archive_databases.ts";

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

test.each(["history.db", "shore.db"])("obsolete retention schema is removed from %s without losing history", (filename) => {
  const paths = dirs();
  const legacyPath = join(paths.data, filename);
  const history = HistoryStore.open(legacyPath);
  history.putSegment("ada", 0, {
    file: "0001.jsonl", message_count: 1, compacted_at: "2020-01-01T00:00:00Z",
  }, [{
    msg_id: "old-message", role: "user", content: "keep my history", images: [],
    content_blocks: [{ type: "text", text: "keep my history" }], timestamp: "2020-01-01T00:00:00Z",
  }]);
  history.close();
  const legacy = new Database(legacyPath);
  legacy.run("ALTER TABLE history_segments ADD COLUMN memory_retain INTEGER NOT NULL DEFAULT 0");
  legacy.run("UPDATE history_segments SET memory_retain = 1");
  legacy.run("ALTER TABLE history_segments ADD COLUMN retain_requested INTEGER");
  legacy.run("ALTER TABLE history_segments ADD COLUMN memory_doc TEXT");
  legacy.run("ALTER TABLE history_segments ADD COLUMN memory_doc_attempts INTEGER NOT NULL DEFAULT 0");
  legacy.run("UPDATE history_segments SET retain_requested = 1, memory_doc = 'pending'");
  legacy.run("CREATE TABLE memory_documents (character TEXT, document_id TEXT)");
  legacy.run("INSERT INTO memory_documents VALUES ('ada', 'old-document')");
  legacy.run("CREATE TABLE history_memory_retain (character TEXT, segment INTEGER, status TEXT)");
  legacy.run("INSERT INTO history_memory_retain VALUES ('ada', 0, 'pending')");
  legacy.run(`INSERT INTO memory_coverage(character, path, version, state, updated_at) VALUES
    ('ada', 'hindsight', 'old-version', 'covered', '2020'),
    ('ada', 'compaction', 'old-version', 'covered', '2020')`);
  legacy.close();

  migrateDatabases(paths);
  migrateDatabases(paths);
  expect(existsSync(legacyPath)).toBe(filename === "shore.db");
  const check = (data: string) => {
    withStorage(data, (db) => {
      const columns = db.query("PRAGMA table_info(history_segments)").all() as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain("memory_retain");
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'history_memory_retain'").get()).toBeNull();
      expect(columns.some(column => column.name === "retain_requested" || column.name.startsWith("memory_doc"))).toBe(false);
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'memory_documents'").get()).toBeNull();
      expect(db.query("SELECT path, version FROM memory_coverage").values()).toEqual([["compaction", "old-version"]]);
      expect(db.query("PRAGMA quick_check").values()).toEqual([["ok"]]);
    });
    const store = HistoryStore.open(databasePath(data));
    try {
      expect(store.readSegment("ada", 0).map((message) => message.content)).toEqual(["keep my history"]);
    } finally { store.close(); }
  };
  check(paths.data);
  const archive = join(paths.root, "export.db");
  exportUnifiedDatabase(databasePath(paths.data), "ada", archive);
  const oldArchive = new Database(archive);
  for (const name of ["memory_retain", "retain_requested", "memory_doc", "memory_doc_attempts", "memory_doc_error", "memory_doc_op", "memory_doc_due", "memory_doc_expires", "memory_doc_id", "memory_doc_claim"]) {
    oldArchive.run(`ALTER TABLE history_segments ADD COLUMN ${name} TEXT`);
  }
  oldArchive.run(`INSERT INTO memory_coverage(character, path, version, state, updated_at)
    VALUES ('ada', 'hindsight', 'old-version', 'covered', '2020')`);
  oldArchive.close();
  const target = dirs();
  importUnifiedDatabase(databasePath(target.data), archive, "ada");
  check(target.data);
  const legacyTarget = dirs();
  importHistoryDatabase(databasePath(legacyTarget.data), archive, "ada");
  check(legacyTarget.data);
  const reopened = HistoryStore.open(databasePath(target.data));
  try {
    reopened.putSegment("ada", 1, {
      file: "0002.jsonl", message_count: 0, compacted_at: "2020-01-02T00:00:00Z",
    }, []);
    expect(reopened.entries("ada")).toHaveLength(2);
  } finally { reopened.close(); }
});

test("zero-byte legacy databases are retired without blocking populated databases", () => {
  const paths = dirs();
  const empty = [join(paths.data, "history.db"), join(paths.data, "calls.db"), join(paths.cache, "ledger.db")];
  for (const path of empty) writeFileSync(path, "");
  capture(join(paths.cache, "calls.db"), "keep");
  migrateDatabases(paths);
  migrateDatabases(paths);
  for (const path of empty) expect(existsSync(path)).toBe(false);
  const store = CallStore.open(databasePath(paths.data));
  try { expect(store.callCount()).toBe(1); } finally { store.close(); }
});

test.each(["-wal", "-journal", "-shm"])("an empty database with a nonempty %s is preserved for inspection", (suffix) => {
  const paths = dirs();
  const path = join(paths.data, "history.db");
  writeFileSync(path, "");
  writeFileSync(`${path}${suffix}`, "potential recovery data");
  expect(() => migrateDatabases(paths)).toThrow();
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(`${path}${suffix}`, "utf8")).toBe("potential recovery data");
});

test("an invalid database is preserved and migration refuses to silently discard it", () => {
  const paths = dirs();
  const legacy = join(paths.data, "ledger.db");
  writeFileSync(legacy, "not a sqlite database");
  expect(() => migrateDatabases(paths)).toThrow();
  expect(readFileSync(legacy, "utf8")).toBe("not a sqlite database");
});

test("compacting old import records preserves deduplication when another source copy arrives", () => {
  const paths = dirs();
  const source = join(paths.cache, "calls.db");
  capture(source, "shared");
  const original = readFileSync(source);
  migrateDatabases(paths);
  withStorage(paths.data, (db) => {
    db.run(`CREATE TABLE old_import_rows (
      kind TEXT NOT NULL, table_name TEXT NOT NULL, digest TEXT NOT NULL,
      occurrence INTEGER NOT NULL, target_id INTEGER,
      PRIMARY KEY(kind, table_name, digest, occurrence));
      INSERT INTO old_import_rows SELECT kind, table_name, lower(hex(digest)), occurrence, target_id FROM storage_import_rows;
      DROP TABLE storage_import_rows;
      ALTER TABLE old_import_rows RENAME TO storage_import_rows;`);
  });
  writeFileSync(join(paths.data, "calls.db"), original);
  migrateDatabases(paths);
  migrateDatabases(paths);
  withStorage(paths.data, (db) => {
    expect(db.query("SELECT wr FROM pragma_table_list WHERE name = 'storage_import_rows'").get()).toEqual({ wr: 1 });
    expect(db.query("SELECT DISTINCT typeof(digest) AS type, length(digest) AS bytes FROM storage_import_rows").all())
      .toEqual([{ type: "blob", bytes: 32 }]);
  });
  const store = CallStore.open(databasePath(paths.data));
  try {
    expect(store.callCount()).toBe(1);
    for (const call of store.queryCalls({ limit: 1 })) expect(store.getCall(call.id)?.request).toContain("shared");
  } finally { store.close(); }
});

test("an invalid legacy import digest rolls back the schema upgrade", () => {
  const paths = dirs();
  withStorage(paths.data, (db) => db.run(`DROP TABLE storage_import_rows;
    CREATE TABLE storage_import_rows (kind TEXT, table_name TEXT, digest TEXT, occurrence INTEGER, target_id INTEGER);
    INSERT INTO storage_import_rows VALUES ('capture', 'capture_calls', 'invalid', 1, 7);`));
  expect(() => migrateDatabases(paths)).toThrow("Invalid storage import digest");
  const db = new Database(databasePath(paths.data), { readonly: true });
  try {
    expect(db.query("SELECT digest, target_id FROM storage_import_rows").get()).toEqual({ digest: "invalid", target_id: 7 });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'storage_import_rows_compact'").get()).toBeNull();
  } finally { db.close(); }
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
