import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { DIAGNOSTIC_RETENTION_MS, pruneDiagnostics } from "../src/storage/retention.ts";
import { databasePath, insertEvent, readEvents, unpack, withStorage, writeState, readState, pack } from "../src/storage/store.ts";
import { appendSubagentTrace } from "../src/tools/subagent_trace.ts";
import { randomUUID } from "node:crypto";
import { bookPathIn, forgetThreadSessions, readBook, sessionKey, writeBook, SESSION_BOOK_VERSION, type SessionRecord } from "../src/llm/providers/agent_sessions.ts";
import { pruneSdkSessions, retireSession } from "../src/llm/providers/agent_session_retention.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const cutoff = NOW - DIAGNOSTIC_RETENTION_MS;
const old = new Date(cutoff - 1000);
function dataDir() {
  const root = mkdtempSync(join(tmpdir(), "shore-retention-"));
  initializeDatabase(root);
  return root;
}

test("only old heartbeat events expire; history, state, ledger and malformed records remain", () => {
  const data = dataDir();
  const history = HistoryStore.open(databasePath(data));
  history.putSegment("ada", 0, { file: "history.db", compacted_at: old.toISOString() }, []);
  history.close();
  writeState(data, "ada/autonomy_state.json", "keep state", "ada");
  withStorage(data, (db) => {
    for (const [kind, timestamp, content] of [
      ["heartbeat", old.toISOString(), "old heartbeat"],
      ["heartbeat", new Date(cutoff).toISOString(), "boundary heartbeat"],
      ["heartbeat", "invalid", "undated heartbeat"],
      ["subagent", old.toISOString(), "malformed trace"],
      ["legacy_invalid", old.toISOString(), "legacy record"],
    ]) insertEvent(db, { character: "ada", kind: kind ?? "", timestamp: timestamp ?? "", content: content ?? "" });
    db.run("INSERT INTO call_attempts(id,started_at,status,character,provider,model,call_type) VALUES ('old','2020','failed','ada','test','test','message')");
  });
  expect(pruneDiagnostics(data, NOW)).toEqual({ captures: 0, heartbeats: 1, subagentTraces: 0, unreadableTraces: 1 });
  expect(readEvents(data, "ada", "heartbeat")).toEqual(["boundary heartbeat", "undated heartbeat"]);
  expect(readEvents(data, "ada", "subagent")).toEqual(["malformed trace"]);
  expect(readEvents(data, "ada", "legacy_invalid")).toEqual(["legacy record"]);
  expect(readState(data, "ada/autonomy_state.json")).toBe("keep state");
  withStorage(data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM history_segments").get()).toEqual({ n: 1 });
    expect(db.query("SELECT id FROM call_attempts").get()).toEqual({ id: "old" });
    expect(db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  });
});

test("an old subagent trace keeps its result and loses its messages, and one missing a field, or not an object, is kept as it was", () => {
  const data = dataDir();
  const trace = { subagent: "researcher", parent_tool_use_id: "tu_1", messages: [{ role: "user", content: "look this up" }], result: "found it" };
  const kept = [null, "text", [trace], { ...trace, subagent: 5 }, { ...trace, parent_tool_use_id: 5 }, { ...trace, messages: "none" }].map((value) => JSON.stringify(value));
  withStorage(data, (db) => {
    for (const content of [JSON.stringify(trace), JSON.stringify({ ...trace, parent_tool_use_id: "tu_2" }), ...kept]) {
      insertEvent(db, { character: "ada", kind: "subagent", timestamp: old.toISOString(), content });
    }
  });
  expect(pruneDiagnostics(data, NOW)).toEqual({ captures: 0, heartbeats: 0, subagentTraces: 2, unreadableTraces: kept.length });
  expect(readEvents(data, "ada", "subagent_result").map((content) => JSON.parse(content) as unknown)).toEqual([
    { ...trace, messages: [], messages_expired: true },
    { ...trace, parent_tool_use_id: "tu_2", messages: [], messages_expired: true },
  ]);
  expect(readEvents(data, "ada", "subagent")).toEqual(kept);
});

function filesOpenIn(folder: string) {
  const inside = `${realpathSync(folder)}/`;
  return readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = readlinkSync(join("/proc/self/fd", fd));
      return target.startsWith(inside) ? [target] : [];
    } catch {
      return [];
    }
  });
}

test("a data folder without a database yet is pruned without error, and no file is left open", () => {
  const data = mkdtempSync(join(tmpdir(), "shore-retention-fresh-"));
  expect(pruneDiagnostics(data, NOW)).toEqual({ captures: 0, heartbeats: 0, subagentTraces: 0, unreadableTraces: 0 });
  expect(existsSync(databasePath(data))).toBe(true);
  expect(filesOpenIn(data)).toEqual([]);
});

test("a write failure rolls back the entire cleanup", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  store.recordCall({ call_id: "old", ts: old, usage: ZERO_USAGE, request_body: "preserve" });
  store.close();
  await appendSubagentTrace(join(data, "ada"), { ts: old.toISOString(), subagent: "helper", parent_tool_use_id: "id", model: "test", messages: [], result: "keep" });
  withStorage(data, (db) => db.run("CREATE TRIGGER reject_expiry BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'write failed'); END"));
  expect(() => pruneDiagnostics(data, NOW)).toThrow("write failed");
  withStorage(data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM capture_calls").get()).toEqual({ n: 1 });
    const event = db.query("SELECT kind, content FROM events").get() as { kind: string; content: Uint8Array };
    expect(event.kind).toBe("subagent");
    expect(unpack(event.content)).not.toContain("messages_expired");
  });
});

const start = Date.parse("2026-09-10T12:00:00Z");
const DAY = 24 * 3_600_000;
const record = (sessionId: string, parent?: string): SessionRecord => ({
  version: SESSION_BOOK_VERSION, sessionId, entries: parent === undefined ? [] : [{ hash: "hash", uuid: "anchor", sessionId: parent }],
});

function fixture() {
  const data = mkdtempSync(join(tmpdir(), "shore-sdk-retention-"));
  const config = join(data, "claude");
  const project = join(config, "projects", "-tmp");
  mkdirSync(project, { recursive: true });
  const book = bookPathIn(data);
  const key = sessionKey("ada", "", "main");
  const local = (id: string) => join(project, `${id}.jsonl`);
  const mirror = nativeHistoryStore(book, key);
  const add = async (id: string) => {
    writeFileSync(local(id), "diagnostic transcript");
    mkdirSync(join(project, id, "subagents"), { recursive: true });
    writeFileSync(join(project, id, "subagents", "agent.jsonl"), "subagent diagnostics");
    await mirror.append({ projectKey: "-tmp", sessionId: id }, [{ type: "user", uuid: randomUUID(), timestamp: "2000-01-01T00:00:00Z" }]);
    await mirror.append({ projectKey: "-tmp", sessionId: id, subpath: "subagents/agent" }, [{ type: "assistant", uuid: randomUUID() }]);
  };
  const prune = (now: number) => pruneSdkSessions(data, now, [config]);
  const stored = () => withStorage(data, db => [...new Set((db.query("SELECT path FROM state_files WHERE path GLOB 'sdk_transcripts/*'").all() as { path: string }[])
    .map(row => Buffer.from(row.path.split("/")[3] ?? "", "base64url").toString()))].sort());
  return { data, config, project, book, key, local, mirror, add, prune, stored };
}

test("retired transcripts last a day; fork ancestors and other threads remain live; reactivation resets the grace period", async () => {
  const f = fixture();
  const parent = randomUUID(), child = randomUUID(), other = randomUUID();
  for (const id of [parent, child, other]) await f.add(id);
  const otherKey = sessionKey("ada", "", "other");
  writeBook(f.book, { [f.key]: record(parent), [otherKey]: record(other) }, start);
  writeBook(f.book, { [f.key]: record(child, parent), [otherKey]: record(other) }, start);
  expect(f.prune(start + DAY * 2)).toBe(0);
  expect(f.prune(start + DAY * 4)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DAY * 4);
  writeBook(f.book, { ...readBook(f.book), [f.key]: record(child, parent) }, start + DAY * 4 + 1);
  expect(f.prune(start + DAY * 6)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DAY * 6);
  expect(f.prune(start + DAY * 7)).toBe(0);
  expect(f.stored()).toEqual([parent, child, other].sort());
  expect(f.prune(start + DAY * 7 + 1)).toBe(2);
  expect(f.stored()).toEqual([other]);
  expect([parent, child, other].map(id => existsSync(f.local(id)))).toEqual([false, false, true]);
  withStorage(f.data, db => expect(db.query("SELECT count(*) AS n FROM state_lines WHERE path NOT IN (SELECT path FROM state_files)").get()).toEqual({ n: 0 }));
});

test("a transcript no book names is retired when first seen and expires a day later, along with its local copies, once", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(f.prune(start)).toBe(0);
  expect(f.prune(start + DAY)).toBe(0);
  expect(f.prune(start + DAY + 1)).toBe(1);
  expect(f.stored()).toEqual([]);
  expect([existsSync(f.local(id)), existsSync(join(f.project, id))]).toEqual([false, false]);
  expect(f.prune(start + DAY * 3)).toBe(0);
});

test("a session dropped from a thread's book is retired under its character", () => {
  const f = fixture();
  writeBook(f.book, { [f.key]: record(randomUUID()) }, start);
  writeBook(f.book, {}, start + 1);
  withStorage(f.data, (db) => expect(db.query("SELECT character FROM state_files WHERE path GLOB 'sdk_retired/*'").all()).toEqual([{ character: "ada" }]));
});

test("expiry clears every project's copies, past stray files, projects without a copy and config folders without projects", async () => {
  const f = fixture();
  const id = randomUUID();
  const bare = randomUUID();
  await f.add(id);
  await f.mirror.append({ projectKey: "-tmp", sessionId: bare }, [{ type: "user", uuid: randomUUID(), timestamp: "2000-01-01T00:00:00Z" }]);
  mkdirSync(join(f.config, "projects", "-other"));
  writeFileSync(join(f.config, "projects", "stray.txt"), "not a project");
  const configs = [f.config, join(f.data, "unused-config")];
  expect(pruneSdkSessions(f.data, start, configs)).toBe(0);
  expect(pruneSdkSessions(f.data, start + DAY + 1, configs)).toBe(2);
  expect([existsSync(f.local(id)), existsSync(join(f.project, id))]).toEqual([false, false]);
  expect(f.stored()).toEqual([]);
});

test("a retired session whose id isn't a UUID never names a file to delete", () => {
  const f = fixture();
  const outside = join(f.config, "projects", "escape.jsonl");
  writeFileSync(outside, "keep");
  withStorage(f.data, (db) => { retireSession(db, "../escape", "ada", start); });
  expect(f.prune(start + DAY + 1)).toBe(1);
  expect(existsSync(outside)).toBe(true);
});

test("retired markers without a session id or a time, and transcript rows without one, are left alone", () => {
  const f = fixture();
  withStorage(f.data, (db) => {
    const insert = db.query("INSERT INTO state_files(path, character, content) VALUES (?1, 'ada', ?2)");
    insert.run("sdk_retired/numbered", pack(JSON.stringify({ sessionId: 5, retiredAt: start })));
    insert.run("sdk_retired/timeless", pack(JSON.stringify({ sessionId: randomUUID(), retiredAt: "soon" })));
    insert.run("sdk_transcripts/short", pack("x"));
  });
  expect(f.prune(start + DAY * 2)).toBe(0);
  withStorage(f.data, (db) => expect((db.query("SELECT path FROM state_files WHERE path GLOB 'sdk_retired/*' ORDER BY path").all() as { path: string }[]).map((row) => row.path)).toEqual(["sdk_retired/numbered", "sdk_retired/timeless"]));
});

test("a session book that doesn't name its session or list its entries, or names a parent that isn't an id, prevents transcript deletion", async () => {
  for (const [content, failure] of [
    [{ sessionId: "s" }, "Invalid SDK session references; preserving transcripts"],
    [{ entries: [] }, "Invalid SDK session references; preserving transcripts"],
    [{ sessionId: "s", entries: [{ hash: "h", uuid: "u", sessionId: 5 }] }, "Invalid SDK parent session; preserving transcripts"],
  ] as const) {
    const f = fixture();
    const id = randomUUID();
    await f.add(id);
    expect(f.prune(start)).toBe(0);
    withStorage(f.data, (db) => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack(JSON.stringify(content))));
    expect(() => f.prune(start + DAY + 1)).toThrow(failure);
    expect(existsSync(f.local(id))).toBe(true);
  }
});

test("an unreadable session book prevents transcript deletion", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(f.prune(start)).toBe(0);
  withStorage(f.data, db => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack("{}")));
  expect(() => f.prune(start + DAY + 1)).toThrow("Invalid SDK session references");
  expect(existsSync(f.local(id))).toBe(true);
});
