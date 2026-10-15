import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { pruneSdkSessions } from "../src/llm/providers/agent_session_retention.ts";
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
  history.putSegment("ada", 0, { file: "history.db", message_count: 0, compacted_at: old.toISOString() }, []);
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
  const prune = (now: number) => pruneSdkSessions(data, now - DIAGNOSTIC_RETENTION_MS, now, config);
  return { data, config, project, book, key, local, mirror, add, prune };
}

test("fork ancestors and other threads remain live; reactivation resets the grace period", async () => {
  const f = fixture();
  const parent = randomUUID(), child = randomUUID(), other = randomUUID();
  for (const id of [parent, child, other]) await f.add(id);
  const otherKey = sessionKey("ada", "", "other");
  writeBook(f.book, { [f.key]: record(parent), [otherKey]: record(other) }, start);
  writeBook(f.book, { [f.key]: record(child, parent), [otherKey]: record(other) }, start);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 2)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DIAGNOSTIC_RETENTION_MS * 2);
  writeBook(f.book, { ...readBook(f.book), [f.key]: record(child, parent) }, start + DIAGNOSTIC_RETENTION_MS * 2 + 1);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 4)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DIAGNOSTIC_RETENTION_MS * 4);
  expect(f.prune(start + DIAGNOSTIC_RETENTION_MS * 5 + 1)).toBe(2);
  expect(existsSync(f.local(other))).toBe(true);
});

test("an unreadable session book prevents transcript deletion", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(f.prune(start)).toBe(0);
  withStorage(f.data, db => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack("{}")));
  expect(() => f.prune(start + DIAGNOSTIC_RETENTION_MS + 1)).toThrow("Invalid SDK session references");
  expect(existsSync(f.local(id))).toBe(true);
});
