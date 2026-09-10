import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { SnapshotGate } from "../src/snapshot_gate.ts";
import { migrateDatabases } from "../src/storage/migrate.ts";
import { DIAGNOSTIC_RETENTION_MS, pruneDiagnostics, startDiagnosticRetention } from "../src/storage/retention.ts";
import { databasePath, insertEvent, pack, readEvents, unpack, withStorage, writeState, readState } from "../src/storage/store.ts";
import { appendSubagentTrace, readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { exportUnifiedDatabase, importUnifiedDatabase } from "../src/storage/archive.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = Date.parse("2026-09-10T12:00:00Z");
const cutoff = now - DIAGNOSTIC_RETENTION_MS;
const old = new Date(cutoff - 1000);
function dataDir() {
  const root = mkdtempSync(join(tmpdir(), "shore-retention-"));
  roots.push(root);
  migrateDatabases({ data: root, cache: root });
  return root;
}

test("age expiry preserves the boundary, shared payloads, and recent HTTP calls without a parent capture", () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  const shared = "shared context ".repeat(1000);
  for (const [id, ts, body] of [["old", old, shared], ["boundary", new Date(cutoff), shared], ["unique", old, "old unique body"]] as const) {
    store.recordCall({ call_id: id, ts, character: "ada", usage: ZERO_USAGE, request_body: body });
  }
  for (const [id, ts] of [["old-wire", old], ["recent-wire", new Date(now)]] as const) {
    store.recordHttpCall({ call_id: id, seq: 0, ts, method: "POST", url: "https://example.test", request_headers: [],
      request_body: Buffer.from(shared), response_headers: [], response_body: null });
  }
  store.database.query("INSERT INTO capture_transcripts(ts,ts_unix,source,entry_zstd) VALUES (?1,?2,'test',?3)")
    .run(old.toISOString(), Math.floor(old.getTime() / 1000), pack("old transcript"));
  const before = store.blobCount();
  store.close();

  expect(pruneDiagnostics(data, now).captures).toBe(4);
  const retained = CallStore.open(databasePath(data));
  try {
    expect(retained.queryCalls({ limit: 0 }).map((row) => row.call_id)).toEqual(["boundary"]);
    for (const call of retained.queryCalls({ limit: 0 })) expect(retained.getCall(call.id)?.request).toBe(shared);
    expect(retained.database.query("SELECT call_id FROM capture_http_calls").all()).toEqual([{ call_id: "recent-wire" }]);
    const wire = retained.database.query("SELECT request_payload_id AS id FROM capture_http_calls").get() as { id: number };
    expect(Buffer.from(retained.loadPayload(wire.id) ?? []).toString()).toBe(shared);
    expect(retained.blobCount()).toBeLessThan(before);
  } finally { retained.close(); }
  expect(pruneDiagnostics(data, now)).toEqual({ captures: 0, heartbeats: 0, subagentTraces: 0, unreadableTraces: 0 });
});

test("subagent results and errors remain addressable after intermediate messages expire, including archive round trips", async () => {
  const data = dataDir();
  const character = join(data, "ada");
  mkdirSync(character);
  const messages = [{ msg_id: "m1", role: "assistant" as const, content: "intermediate work", images: [],
    content_blocks: [{ type: "text" as const, text: "intermediate work" }], timestamp: old.toISOString() }];
  for (const [id, ts, outcome] of [
    ["old-result", old.toISOString(), { result: "final answer" }],
    ["old-error", old.toISOString(), { error: "run failed" }],
    ["boundary", new Date(cutoff).toISOString(), { result: "recent answer" }],
  ] as const) {
    await appendSubagentTrace(character, { ts, subagent: "researcher", parent_tool_use_id: id, rid: "request", model: "test", messages, ...outcome });
  }
  expect(pruneDiagnostics(data, now).subagentTraces).toBe(2);
  const traces = await readSubagentTraces(character);
  expect(traces.map((trace) => trace.parent_tool_use_id)).toEqual(["old-result", "old-error", "boundary"]);
  expect(traces[0]).toEqual({ ts: old.toISOString(), subagent: "researcher", parent_tool_use_id: "old-result", rid: "request",
    model: "test", result: "final answer", messages: [], messages_expired: true });
  expect(traces[1]?.error).toBe("run failed");
  expect(traces[1]?.messages).toEqual([]);
  expect(traces[2]?.messages).toEqual(messages);
  expect(traces[2]?.messages_expired).toBeUndefined();
  expect((await readSubagentTraces(character, { ids: ["old-result"] }))[0]?.result).toBe("final answer");
  expect((await readSubagentTraces(character, { count: 2 })).map((trace) => trace.parent_tool_use_id)).toEqual(["old-error", "boundary"]);
  expect(pruneDiagnostics(data, now).subagentTraces).toBe(0);
  const archive = join(data, "archive.db");
  exportUnifiedDatabase(databasePath(data), "ada", archive);
  const target = dataDir();
  importUnifiedDatabase(databasePath(target), archive, "ada");
  expect(await readSubagentTraces(join(target, "ada"))).toEqual(traces);
});

test("only old heartbeat events expire; history, state, ledger and malformed records remain", () => {
  const data = dataDir();
  const history = HistoryStore.open(databasePath(data));
  history.putSegment("ada", 0, { file: "history.db", message_count: 0, compacted_at: old.toISOString(), retain: true }, []);
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
  expect(readState(data, "ada/autonomy_state.json", "ada")).toBe("keep state");
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

test("stopping retention cancels a sweep waiting for an archive snapshot", async () => {
  const data = dataDir();
  const gate = new SnapshotGate();
  await gate.withSnapshot(async () => {
    const timer = startDiagnosticRetention(data, gate, 5);
    timer.stop();
    const db = new Database(databasePath(data));
    db.run("DROP TABLE capture_calls");
    db.close();
  });
  await Bun.sleep(10);
  const db = new Database(databasePath(data), { readonly: true });
  try { expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'capture_calls'").get()).toBeNull(); }
  finally { db.close(); }
});
