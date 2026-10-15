import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { DIAGNOSTIC_RETENTION_MS, pruneDiagnostics } from "../src/storage/retention.ts";
import { databasePath, insertEvent, readEvents, unpack, withStorage, writeState, readState } from "../src/storage/store.ts";
import { appendSubagentTrace } from "../src/tools/subagent_trace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = Date.parse("2026-09-10T12:00:00Z");
const cutoff = now - DIAGNOSTIC_RETENTION_MS;
const old = new Date(cutoff - 1000);
function dataDir() {
  const root = mkdtempSync(join(tmpdir(), "shore-retention-"));
  roots.push(root);
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
  expect(pruneDiagnostics(data, now)).toEqual({ captures: 0, heartbeats: 1, subagentTraces: 0, unreadableTraces: 1 });
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
  expect(() => pruneDiagnostics(data, now)).toThrow("write failed");
  withStorage(data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM capture_calls").get()).toEqual({ n: 1 });
    const event = db.query("SELECT kind, content FROM events").get() as { kind: string; content: Uint8Array };
    expect(event.kind).toBe("subagent");
    expect(unpack(event.content)).not.toContain("messages_expired");
  });
});
