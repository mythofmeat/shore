import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore, ZERO_USAGE, type HttpExchangeRecord } from "../src/call_store.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { shoreLog } from "../src/log.ts";
import { SnapshotGate } from "../src/snapshot_gate.ts";
import { DIAGNOSTIC_RETENTION_MS, pruneDiagnostics, startDiagnosticRetention } from "../src/storage/retention.ts";
import { closeStorageConnections, databasePath, insertEvent, readEvents, unpack, withStorage, writeState, readState, pack } from "../src/storage/store.ts";
import { required } from "../src/util/required.ts";
import { appendSubagentTrace } from "../src/tools/subagent_trace.ts";
import { createHash, randomUUID } from "node:crypto";
import { bookPathIn, forgetThreadSessions, readBook, sessionKey, writeBook, SESSION_BOOK_VERSION, type SessionRecord } from "../src/llm/providers/agent_sessions.ts";
import { pruneSdkSessions, retireSession } from "../src/llm/providers/agent_session_retention.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import { setTestEnv } from "./support/env.ts";
import { handlesUnder } from "./support/handles.ts";
import { outcomeOf } from "./support/outcome.ts";
import { until } from "./support/until.ts";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const cutoff = NOW - DIAGNOSTIC_RETENTION_MS;
const old = new Date(cutoff - 1000);
function dataDir() {
  const root = mkdtempSync(join(tmpdir(), "shore-retention-"));
  initializeDatabase(root);
  return root;
}

test("only old wake events expire; history, state, ledger and malformed records remain", async () => {
  const data = dataDir();
  const history = HistoryStore.open(databasePath(data));
  history.putSegment("ada", 0, { file: "history.db", compacted_at: old.toISOString() }, []);
  history.close();
  writeState(data, "ada/autonomy_state.json", "keep state", "ada");
  withStorage(data, (db) => {
    for (const [kind, timestamp, content] of [
      ["wake", old.toISOString(), "old wake"],
      ["wake", new Date(cutoff).toISOString(), "boundary wake"],
      ["wake", "invalid", "undated wake"],
      ["subagent", old.toISOString(), "malformed trace"],
      ["legacy_invalid", old.toISOString(), "legacy record"],
    ]) insertEvent(db, { character: "ada", kind: kind ?? "", timestamp: timestamp ?? "", content: content ?? "" });
    db.run("INSERT INTO call_attempts(id,started_at,status,character,provider,model,call_type) VALUES ('old','2020','failed','ada','test','test','message')");
  });
  expect(await pruneDiagnostics(data, NOW)).toEqual({ captures: 0, wakeEvents: 1, subagentTraces: 0, unreadableTraces: 1 });
  expect(readEvents(data, "ada", "wake")).toEqual(["boundary wake", "undated wake"]);
  expect(readEvents(data, "ada", "subagent")).toEqual(["malformed trace"]);
  expect(readEvents(data, "ada", "legacy_invalid")).toEqual(["legacy record"]);
  expect(readState(data, "ada/autonomy_state.json")).toBe("keep state");
  withStorage(data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM history_segments").get()).toEqual({ n: 1 });
    expect(db.query("SELECT id FROM call_attempts").get()).toEqual({ id: "old" });
    expect(db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  });
});

test("an old subagent trace keeps its result and loses its messages, and one missing a field, or not an object, is kept as it was", async () => {
  const data = dataDir();
  const trace = { subagent: "researcher", parent_tool_use_id: "tu_1", messages: [{ role: "user", content: "look this up" }], result: "found it" };
  const kept = [null, "text", [trace], { ...trace, subagent: 5 }, { ...trace, parent_tool_use_id: 5 }, { ...trace, messages: "none" }].map((value) => JSON.stringify(value));
  withStorage(data, (db) => {
    for (const content of [JSON.stringify(trace), JSON.stringify({ ...trace, parent_tool_use_id: "tu_2" }), ...kept]) {
      insertEvent(db, { character: "ada", kind: "subagent", timestamp: old.toISOString(), content });
    }
  });
  expect(await pruneDiagnostics(data, NOW)).toEqual({ captures: 0, wakeEvents: 0, subagentTraces: 2, unreadableTraces: kept.length });
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

test("a data folder without a database yet is pruned without error, and no file is left open", async () => {
  const data = mkdtempSync(join(tmpdir(), "shore-retention-fresh-"));
  expect(await pruneDiagnostics(data, NOW)).toEqual({ captures: 0, wakeEvents: 0, subagentTraces: 0, unreadableTraces: 0 });
  expect(existsSync(databasePath(data))).toBe(true);
  expect(filesOpenIn(data)).toEqual([]);
});

test("a write failure while expiring traces undoes that step and stops before the captures", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  store.recordCall({ call_id: "old", ts: old, usage: ZERO_USAGE, request_body: "preserve" });
  store.close();
  await appendSubagentTrace(join(data, "ada"), { ts: old.toISOString(), subagent: "helper", parent_tool_use_id: "id", model: "test", messages: [], result: "keep" });
  withStorage(data, (db) => db.run("CREATE TRIGGER reject_expiry BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'write failed'); END"));
  expect(await outcomeOf(pruneDiagnostics(data, NOW))).toThrow("write failed");
  withStorage(data, (db) => {
    expect(db.query("SELECT count(*) AS n FROM capture_calls").get()).toEqual({ n: 1 });
    const event = db.query("SELECT kind, content FROM events").get() as { kind: string; content: Uint8Array };
    expect(event.kind).toBe("subagent");
    expect(unpack(event.content)).not.toContain("messages_expired");
  });
});

const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const BATCH = 256;
const recent = new Date(NOW - 60_000);

function noise(seed: string, length: number): string {
  let out = "";
  for (let k = 0; out.length < length; k++) out += createHash("sha256").update(`${seed}/${k}`).digest("hex");
  return out.slice(0, length);
}

interface Stored { rows: number; payloads: number; chunks: number; free: number }

function captureCounts(data: string): Stored {
  const db = new Database(databasePath(data), { readonly: true });
  try {
    const n = (sql: string): number => (db.query(sql).get() as { n: number }).n;
    return {
      rows: n("SELECT (SELECT count(*) FROM capture_calls) + (SELECT count(*) FROM capture_http_calls) + (SELECT count(*) FROM capture_transcripts) AS n"),
      payloads: n("SELECT count(*) AS n FROM capture_payloads"),
      chunks: n("SELECT count(*) AS n FROM capture_blobs"),
      free: (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
    };
  } finally {
    db.close();
  }
}

function bodiesOf(data: string): Map<string, [string | null, string | null]> {
  const store = CallStore.open(databasePath(data));
  try {
    const text = (id: number | null): string | null => {
      if (id === null) return null;
      const bytes = store.loadPayload(id);
      return bytes === null ? "unreadable" : Buffer.from(bytes).toString("utf8");
    };
    const rows = store.database.query("SELECT call_id, request_payload_id AS request, response_payload_id AS response FROM capture_calls ORDER BY id").all() as { call_id: string; request: number | null; response: number | null }[];
    return new Map(rows.map((row) => [row.call_id, [text(row.request), text(row.response)]]));
  } finally {
    store.close();
  }
}

function unreadableExchanges(data: string): string[] {
  const store = CallStore.open(databasePath(data));
  try {
    const rows = store.database.query("SELECT call_id, seq, request_payload_id AS request, response_payload_id AS response FROM capture_http_calls").all() as { call_id: string; seq: number; request: number | null; response: number | null }[];
    return rows.filter((row) => [row.request, row.response].some((id) => id !== null && store.loadPayload(id) === null)).map((row) => `${row.call_id}#${row.seq}`);
  } finally {
    store.close();
  }
}

async function whileSweeping<T>(sweep: () => Promise<T>, everyTurn: () => void): Promise<T> {
  let spinning = true;
  const turn = (): void => {
    if (!spinning) return;
    everyTurn();
    setImmediate(turn);
  };
  setImmediate(turn);
  try {
    return await sweep();
  } finally {
    spinning = false;
  }
}

function exchange(callId: string, ts: Date, request: string, response: string | null): HttpExchangeRecord {
  return { call_id: callId, seq: 0, ts, method: "POST", url: "https://api.example/v1", request_headers: [], request_body: Buffer.from(request), response_headers: null, response_body: response === null ? null : Buffer.from(response) };
}

test("old captures go at most 256 rows, payloads, chunks or pages at a time, with a turn for everything else between batches, and every capture still in its window keeps all it points at", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  const shared = "a prompt an old capture sent too";
  const kept = new Map<string, [string | null, string | null]>();
  for (let i = 0; i < 300; i++) {
    const request = i === 0 ? shared : noise(`live-${i}`, 2048);
    const response = i % 2 === 0 ? noise(`live-reply-${i}`, 2048) : null;
    store.recordCall({ call_id: `live-${i}`, ts: recent, usage: ZERO_USAGE, request_body: request, response_body: response });
    kept.set(`live-${i}`, [request, response]);
  }
  store.recordHttpCall(exchange("live-0", recent, "a live exchange", "its reply"));
  store.recordTranscript({ ts: recent, source: "sdk", iteration: 0, usage: ZERO_USAGE, entry_json: "{}" });
  for (let i = 0; i < 300; i++) {
    store.recordCall({ call_id: `old-${i}`, ts: old, usage: ZERO_USAGE, request_body: i === 0 ? shared : noise(`old-${i}`, 8192), response_body: noise(`old-reply-${i}`, 8192) });
  }
  for (let i = 0; i < 20; i++) {
    store.recordHttpCall(exchange(`old-${i}`, old, noise(`old-exchange-${i}`, 8192), null));
    store.recordTranscript({ ts: old, source: "sdk", iteration: i, usage: ZERO_USAGE, entry_json: JSON.stringify({ i }) });
  }
  store.close();

  const seen = [captureCounts(data)];
  const stats = await whileSweeping(async () => await pruneDiagnostics(data, NOW), () => { seen.push(captureCounts(data)); });
  seen.push(captureCounts(data));
  const largest = (key: keyof Stored): number => Math.max(...seen.slice(1).map((now, i) => (seen[i]?.[key] ?? 0) - now[key]));

  expect(stats).toEqual({ captures: 340, wakeEvents: 0, subagentTraces: 0, unreadableTraces: 0 });
  expect({ rows: largest("rows"), payloads: largest("payloads"), chunks: largest("chunks"), free: largest("free") }).toEqual({ rows: BATCH, payloads: BATCH, chunks: BATCH, free: BATCH });
  expect(seen.at(-1)).toEqual({ rows: 302, payloads: 452, chunks: 452, free: 0 });
  expect(bodiesOf(data)).toEqual(kept);
  expect(unreadableExchanges(data)).toEqual([]);
});

test("captures saved while old ones are cleared, and imported rows that take up an old payload again, keep everything they point at", async () => {
  const data = dataDir();
  const setup = CallStore.open(databasePath(data));
  for (let i = 0; i < 5; i++) setup.recordCall({ call_id: `live-${i}`, ts: recent, usage: ZERO_USAGE, request_body: noise(`live-${i}`, 512) });
  const chunkOf = new Map<string, string>();
  for (let i = 0; i < 400; i++) {
    const body = noise(`old-${i}`, 512);
    setup.recordCall({ call_id: `old-${i}`, ts: old, usage: ZERO_USAGE, request_body: body });
    const payload = setup.database.query("SELECT request_payload_id AS id FROM capture_calls WHERE call_id = ?1").get(`old-${i}`) as { id: number };
    chunkOf.set(required(setup.payloadChunks(payload.id)?.[0]).hash, body);
  }
  setup.close();

  const writer = CallStore.open(databasePath(data));
  const expected = new Map<string, [string | null, string | null]>();
  for (let i = 0; i < 5; i++) expected.set(`live-${i}`, [noise(`live-${i}`, 512), null]);
  const reused = new Set<string>();
  let turn = 0;
  try {
    await whileSweeping(async () => await pruneDiagnostics(data, NOW), () => {
      turn += 1;
      const db = writer.database;
      const pending = [...chunkOf].find(([hash, body]) => !reused.has(body) && db.query("SELECT 1 FROM capture_blobs WHERE hash = ?1").get(hash) !== null);
      if (pending !== undefined) {
        reused.add(pending[1]);
        writer.recordCall({ call_id: `saved-${turn}`, ts: recent, usage: ZERO_USAGE, request_body: pending[1] });
        expected.set(`saved-${turn}`, [pending[1], null]);
      }
      const orphan = db.query(`SELECT id FROM capture_payloads WHERE id NOT IN (
          SELECT request_payload_id FROM capture_calls WHERE request_payload_id IS NOT NULL
          UNION SELECT response_payload_id FROM capture_calls WHERE response_payload_id IS NOT NULL) ORDER BY id LIMIT 1`).get() as { id: number } | null;
      if (orphan !== null) {
        db.query("INSERT INTO capture_calls (call_id, ts, ts_unix, request_payload_id) VALUES (?1, ?2, ?3, ?4)")
          .run(`imported-${turn}`, recent.toISOString(), Math.floor(recent.getTime() / 1000), orphan.id);
        expected.set(`imported-${turn}`, [Buffer.from(required(writer.loadPayload(orphan.id))).toString("utf8"), null]);
      }
    });
  } finally {
    writer.close();
  }

  const kinds = new Set([...expected.keys()].map((id) => id.split("-")[0]));
  expect(kinds).toEqual(new Set(["live", "saved", "imported"]));
  expect(bodiesOf(data)).toEqual(expected);
});

test("one old capture goes with its payloads and chunks, and a sweep that finds nothing old leaves the stored captures alone", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  store.recordCall({ call_id: "live", ts: recent, usage: ZERO_USAGE, request_body: "still in the window" });
  store.storePayload("a payload nothing points at");
  store.close();
  expect((await pruneDiagnostics(data, NOW)).captures).toBe(0);
  expect(captureCounts(data)).toMatchObject({ rows: 1, payloads: 2, chunks: 2 });

  const later = CallStore.open(databasePath(data));
  later.recordCall({ call_id: "old", ts: old, usage: ZERO_USAGE, request_body: "past the window", response_body: "its reply" });
  later.close();
  expect((await pruneDiagnostics(data, NOW)).captures).toBe(1);
  expect(captureCounts(data)).toMatchObject({ rows: 1, payloads: 1, chunks: 1 });
  expect(bodiesOf(data)).toEqual(new Map([["live", ["still in the window", null]]]));
});

test("a database that can't hand pages back to the disk still finishes its sweep", async () => {
  const data = mkdtempSync(join(tmpdir(), "shore-retention-fixed-size-"));
  const fixed = new Database(databasePath(data), { create: true });
  fixed.run("PRAGMA auto_vacuum = NONE; CREATE TABLE placeholder (x INTEGER);");
  fixed.close();
  const store = CallStore.open(databasePath(data));
  for (let i = 0; i < 300; i++) store.recordCall({ call_id: `old-${i}`, ts: old, usage: ZERO_USAGE, request_body: noise(`old-${i}`, 8192) });
  store.close();
  expect((await pruneDiagnostics(data, NOW)).captures).toBe(300);
  const after = captureCounts(data);
  expect({ ...after, free: after.free > BATCH }).toEqual({ rows: 0, payloads: 0, chunks: 0, free: true });
});

test("a write failure part-way through clearing captures leaves every capture readable, and the next sweep finishes the job", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  for (let i = 0; i < 3; i++) store.recordCall({ call_id: `live-${i}`, ts: recent, usage: ZERO_USAGE, request_body: `live ${i}` });
  for (let i = 0; i < 300; i++) store.recordCall({ call_id: `old-${i}`, ts: old, usage: ZERO_USAGE, request_body: `old ${i}` });
  store.close();
  withStorage(data, (db) => db.run("CREATE TRIGGER reject_chunk_removal BEFORE DELETE ON capture_blobs BEGIN SELECT RAISE(ABORT, 'write failed'); END"));
  expect(await outcomeOf(pruneDiagnostics(data, NOW))).toThrow("write failed");
  expect(captureCounts(data)).toMatchObject({ rows: 3, payloads: 3, chunks: 303 });
  expect([...bodiesOf(data).values()]).toEqual([["live 0", null], ["live 1", null], ["live 2", null]]);

  withStorage(data, (db) => db.run("DROP TRIGGER reject_chunk_removal"));
  const later = CallStore.open(databasePath(data));
  later.recordCall({ call_id: "old-later", ts: old, usage: ZERO_USAGE, request_body: "old later" });
  later.close();
  expect((await pruneDiagnostics(data, NOW)).captures).toBe(1);
  expect(captureCounts(data)).toEqual({ rows: 3, payloads: 3, chunks: 3, free: 0 });
});

test("a sweep told to stop finishes the batch it is on, stops there and closes the database", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  for (let i = 0; i < 300; i++) store.recordCall({ call_id: `old-${i}`, ts: old, usage: ZERO_USAGE, request_body: `old ${i}` });
  store.close();
  closeStorageConnections();
  const open = handlesUnder(data);
  const stopping = new AbortController();
  const stats = await whileSweeping(async () => await pruneDiagnostics(data, NOW, stopping.signal), () => { stopping.abort(); });
  expect(stats.captures).toBe(BATCH);
  expect(captureCounts(data).rows).toBe(300 - BATCH);
  expect(handlesUnder(data)).toBe(open);
});

test("the sweep the daemon starts says what it removed, whichever kinds those were, and says nothing when there was nothing to remove", async () => {
  setTestEnv("CLAUDE_CONFIG_DIR", mkdtempSync(join(tmpdir(), "shore-retention-claude-")));
  const long = LONG_AGO.toISOString();
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    const swept = async (seed: (data: string) => Promise<void>): Promise<string[]> => {
      const data = dataDir();
      await seed(data);
      said.mockClear();
      warned.mockClear();
      const gate = new SnapshotGate();
      const sweeping = startDiagnosticRetention(data, gate, 3_600_000);
      await gate.withSnapshot(async () => {});
      await sweeping.stop();
      return [...said.mock.calls, ...warned.mock.calls].map((call) => String(call[0]));
    };
    const wake = (data: string): void => { withStorage(data, (db) => { insertEvent(db, { character: "ada", kind: "wake", timestamp: long, content: "an old wake" }); }); };
    const trace = async (data: string): Promise<void> => {
      await appendSubagentTrace(join(data, "ada"), { ts: long, subagent: "helper", parent_tool_use_id: "id", model: "test", messages: [], result: "keep" });
    };
    const capture = (data: string): void => {
      const store = CallStore.open(databasePath(data));
      store.recordCall({ call_id: "old", ts: LONG_AGO, usage: ZERO_USAGE, request_body: "an old prompt" });
      store.close();
    };
    expect(await swept(async () => {})).toEqual([]);
    expect(await swept(async (data) => { wake(data); })).toEqual(["shore: diagnostic retention removed 0 captures and 1 wake events; retained results for 0 expired subagent traces"]);
    expect(await swept(trace)).toEqual(["shore: diagnostic retention removed 0 captures and 0 wake events; retained results for 1 expired subagent traces"]);
    expect(await swept(async (data) => { capture(data); wake(data); })).toEqual(["shore: diagnostic retention removed 1 captures and 1 wake events; retained results for 0 expired subagent traces"]);
    expect(await swept(async (data) => { wake(data); await trace(data); })).toEqual(["shore: diagnostic retention removed 0 captures and 1 wake events; retained results for 1 expired subagent traces"]);
    expect(await swept(async (data) => {
      withStorage(data, (db) => { insertEvent(db, { character: "ada", kind: "subagent", timestamp: long, content: "not a trace" }); });
    })).toEqual(["shore: diagnostic retention preserved 1 unreadable subagent traces"]);
    expect(await swept(async (data) => {
      withStorage(data, (db) => { retireSession(db, randomUUID(), "ada", Date.now() - 2 * 24 * 3_600_000); });
    })).toEqual(["shore: diagnostic retention removed 1 retired SDK sessions and their transcript copies"]);
  } finally {
    said.mockRestore();
    warned.mockRestore();
  }
});

test("a sweep that comes due while one is still running is skipped", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  for (let i = 0; i < 300; i++) store.recordCall({ call_id: `old-${i}`, ts: LONG_AGO, usage: ZERO_USAGE, request_body: `old ${i}` });
  store.close();
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  try {
    const gate = new SnapshotGate();
    let release = (): void => {};
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const held = gate.withSnapshot(async () => { await holding; });
    const sweeping = startDiagnosticRetention(data, gate, 1);
    await Bun.sleep(30);
    release();
    await held;
    await until(() => said.mock.calls.length > 0, "the sweep's report", 3_000);
    await sweeping.stop();
    await gate.withSnapshot(async () => {});
    expect(said.mock.calls.map((call) => String(call[0]))).toEqual(["shore: diagnostic retention removed 300 captures and 0 wake events; retained results for 0 expired subagent traces"]);
  } finally {
    said.mockRestore();
  }
});

test("once a sweep is done, the next one runs when it comes due", async () => {
  const data = dataDir();
  const gate = new SnapshotGate();
  const sweeping = startDiagnosticRetention(data, gate, 5);
  try {
    await gate.withSnapshot(async () => {});
    withStorage(data, (db) => { insertEvent(db, { character: "ada", kind: "wake", timestamp: LONG_AGO.toISOString(), content: "an old wake" }); });
    await until(() => readEvents(data, "ada", "wake").length === 0, "the next sweep", 3_000);
  } finally {
    await sweeping.stop();
    await gate.withSnapshot(async () => {});
  }
});

test("a sweep stopped while it waits for a snapshot does nothing once the snapshot is done", async () => {
  const data = dataDir();
  withStorage(data, (db) => { insertEvent(db, { character: "ada", kind: "wake", timestamp: LONG_AGO.toISOString(), content: "an old wake" }); });
  const gate = new SnapshotGate();
  let release = (): void => {};
  const holding = new Promise<void>((resolve) => { release = resolve; });
  const held = gate.withSnapshot(async () => { await holding; });
  const sweeping = startDiagnosticRetention(data, gate, 3_600_000);
  const stopped = sweeping.stop();
  release();
  await held;
  await stopped;
  await gate.withSnapshot(async () => {});
  expect(readEvents(data, "ada", "wake")).toEqual(["an old wake"]);
});

test("stopping the daemon mid-sweep ends the sweep after the batch it is on, says what went, and leaves the SDK sessions for the next sweep", async () => {
  setTestEnv("CLAUDE_CONFIG_DIR", mkdtempSync(join(tmpdir(), "shore-retention-claude-")));
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  for (let i = 0; i < 300; i++) store.recordCall({ call_id: `old-${i}`, ts: LONG_AGO, usage: ZERO_USAGE, request_body: `old ${i}` });
  store.close();
  withStorage(data, (db) => { retireSession(db, randomUUID(), "ada", Date.now() - 2 * 24 * 3_600_000); });
  const retired = (): number => withStorage(data, (db) => (db.query("SELECT count(*) AS n FROM state_files WHERE path GLOB 'sdk_retired/*'").get() as { n: number }).n);
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  try {
    const gate = new SnapshotGate();
    let sweeping: { stop(): void } | undefined;
    await whileSweeping(async () => {
      sweeping = startDiagnosticRetention(data, gate, 3_600_000);
      await gate.withSnapshot(async () => {});
    }, () => { sweeping?.stop(); });
    expect(captureCounts(data).rows).toBe(300 - BATCH);
    expect(retired()).toBe(1);
    expect(said.mock.calls.map((call) => String(call[0]))).toEqual([`shore: diagnostic retention removed ${BATCH} captures and 0 wake events; retained results for 0 expired subagent traces`]);
  } finally {
    said.mockRestore();
  }
});

test("the daily sweep's timer doesn't keep the daemon alive, and stopping releases it", async () => {
  const set = spyOn(globalThis, "setInterval");
  const cleared = spyOn(globalThis, "clearInterval");
  try {
    const gate = new SnapshotGate();
    const sweeping = startDiagnosticRetention(dataDir(), gate, 3_600_000);
    const index = set.mock.calls.findIndex((call) => call[1] === 3_600_000);
    const timer = set.mock.results[index]?.value as ReturnType<typeof setInterval>;
    expect(timer.hasRef()).toBe(false);
    const stopped = sweeping.stop();
    expect(cleared).toHaveBeenCalledWith(timer);
    await stopped;
    await gate.withSnapshot(async () => {});
  } finally {
    set.mockRestore();
    cleared.mockRestore();
  }
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
  const prune = async (now: number) => await pruneSdkSessions(data, now, [config]);
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
  expect(await f.prune(start + DAY * 2)).toBe(0);
  expect(await f.prune(start + DAY * 4)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DAY * 4);
  writeBook(f.book, { ...readBook(f.book), [f.key]: record(child, parent) }, start + DAY * 4 + 1);
  expect(await f.prune(start + DAY * 6)).toBe(0);
  forgetThreadSessions(f.data, "ada", "main", start + DAY * 6);
  expect(await f.prune(start + DAY * 7)).toBe(0);
  expect(f.stored()).toEqual([parent, child, other].sort());
  expect(await f.prune(start + DAY * 7 + 1)).toBe(2);
  expect(f.stored()).toEqual([other]);
  expect([parent, child, other].map(id => existsSync(f.local(id)))).toEqual([false, false, true]);
  withStorage(f.data, db => expect(db.query("SELECT count(*) AS n FROM state_lines WHERE path NOT IN (SELECT path FROM state_files)").get()).toEqual({ n: 0 }));
});

test("a transcript no book names is retired when first seen and expires a day later, along with its local copies, once", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(await f.prune(start)).toBe(0);
  expect(await f.prune(start + DAY)).toBe(0);
  expect(await f.prune(start + DAY + 1)).toBe(1);
  expect(f.stored()).toEqual([]);
  expect([existsSync(f.local(id)), existsSync(join(f.project, id))]).toEqual([false, false]);
  expect(await f.prune(start + DAY * 3)).toBe(0);
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
  expect(await pruneSdkSessions(f.data, start, configs)).toBe(0);
  expect(await pruneSdkSessions(f.data, start + DAY + 1, configs)).toBe(2);
  expect([existsSync(f.local(id)), existsSync(join(f.project, id))]).toEqual([false, false]);
  expect(f.stored()).toEqual([]);
});

test("a retired session whose id isn't a UUID never names a file to delete", async () => {
  const f = fixture();
  const outside = join(f.config, "projects", "escape.jsonl");
  writeFileSync(outside, "keep");
  withStorage(f.data, (db) => { retireSession(db, "../escape", "ada", start); });
  expect(await f.prune(start + DAY + 1)).toBe(1);
  expect(existsSync(outside)).toBe(true);
});

test("retired markers without a session id or a time, and transcript rows without one, are left alone", async () => {
  const f = fixture();
  withStorage(f.data, (db) => {
    const insert = db.query("INSERT INTO state_files(path, character, content) VALUES (?1, 'ada', ?2)");
    insert.run("sdk_retired/numbered", pack(JSON.stringify({ sessionId: 5, retiredAt: start })));
    insert.run("sdk_retired/timeless", pack(JSON.stringify({ sessionId: randomUUID(), retiredAt: "soon" })));
    insert.run("sdk_transcripts/short", pack("x"));
  });
  expect(await f.prune(start + DAY * 2)).toBe(0);
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
    expect(await f.prune(start)).toBe(0);
    withStorage(f.data, (db) => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack(JSON.stringify(content))));
    expect(await outcomeOf(f.prune(start + DAY + 1))).toThrow(failure);
    expect(existsSync(f.local(id))).toBe(true);
  }
});

test("an unreadable session book prevents transcript deletion", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(await f.prune(start)).toBe(0);
  withStorage(f.data, db => db.query("INSERT INTO state_files VALUES ('sdk_sessions/broken/key', 'ada', ?1)").run(pack("{}")));
  expect(await outcomeOf(f.prune(start + DAY + 1))).toThrow("Invalid SDK session references");
  expect(existsSync(f.local(id))).toBe(true);
});

test("a session taken up again while old ones are being expired keeps its transcripts", async () => {
  const f = fixture();
  const resumed = randomUUID(), gone = randomUUID();
  for (const id of [resumed, gone]) await f.add(id);
  expect(await f.prune(start)).toBe(0);
  let taken = false;
  const removed = await whileSweeping(async () => await f.prune(start + DAY + 1), () => {
    if (taken) return;
    taken = true;
    writeBook(f.book, { [f.key]: record(resumed) }, start + DAY + 1);
  });
  expect(removed).toBe(1);
  expect(f.stored()).toEqual([resumed]);
  expect([existsSync(f.local(resumed)), existsSync(f.local(gone))]).toEqual([true, false]);
});

test("expiring old sessions gives everything else a turn between one session and the next, and leaves nothing open", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.add(randomUUID());
  expect(await f.prune(start)).toBe(0);
  expect(f.stored()).toHaveLength(3);
  const open = handlesUnder(f.data);
  const left: number[] = [];
  expect(await whileSweeping(async () => await f.prune(start + DAY + 1), () => { left.push(f.stored().length); })).toBe(3);
  expect(left.slice(0, 3)).toEqual([3, 2, 1]);
  expect(handlesUnder(f.data)).toBe(open);
});

test("a sweep stopped before it reaches the sessions leaves them all, and never makes a data folder that has gone", async () => {
  const f = fixture();
  const id = randomUUID();
  await f.add(id);
  expect(await f.prune(start)).toBe(0);
  const stopped = new AbortController();
  stopped.abort();
  const gone = join(f.data, "gone");
  expect(await pruneSdkSessions(gone, start + DAY + 1, [f.config], stopped.signal)).toBe(0);
  expect(existsSync(gone)).toBe(false);
  const midway = new AbortController();
  expect(await whileSweeping(async () => await pruneSdkSessions(f.data, start + DAY + 1, [f.config], midway.signal), () => { midway.abort(); })).toBe(0);
  expect(f.stored()).toEqual([id]);
  expect(existsSync(f.local(id))).toBe(true);
});

test("stopping a sweep that is under way resolves only once the sweep has let go of the database", async () => {
  const data = dataDir();
  const store = CallStore.open(databasePath(data));
  for (let i = 0; i < 600; i++) store.recordCall({ call_id: `old-${i}`, ts: LONG_AGO, usage: ZERO_USAGE, request_body: `old ${i}` });
  store.close();
  closeStorageConnections();
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  try {
    const gate = new SnapshotGate();
    const sweeping = startDiagnosticRetention(data, gate, 3_600_000);
    await Bun.sleep(0);
    await sweeping.stop();
    expect(handlesUnder(data)).toBe(0);
  } finally {
    said.mockRestore();
  }
});
