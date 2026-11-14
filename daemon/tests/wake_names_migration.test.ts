import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { CacheTracker } from "../src/cache/tracker.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { Ledger } from "../src/ledger/store.ts";
import { bookPathIn, readBook, SESSION_BOOK_VERSION, sessionKey, writeBook } from "../src/llm/providers/agent_sessions.ts";
import { conversationKey } from "../src/llm/providers/claude_agent.ts";
import { shoreLog } from "../src/log.ts";
import { createRuntime } from "../src/runtime.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { closeStorageConnections, databasePath } from "../src/storage/store.ts";
import { renameRecordedHeartbeatCalls } from "../src/storage/wake_names_migration.ts";
import { testTmp } from "./support/tmp.ts";

afterEach(() => {
  closeLedgers();
  closeStorageConnections();
});

const TABLES = ["calls", "call_attempts", "capture_calls", "capture_transcripts", "capture_http_calls"] as const;

function record(path: string, callTypes: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const [index, callType] of callTypes.entries()) {
      const id = `${callType}-${String(index)}-${String(Math.random())}`;
      db.query(
        `INSERT INTO calls (ts, character, provider, model, call_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_ms, ttft_ms, finish_reason, thinking_enabled)
         VALUES ('2026-11-01T00:00:00.000Z', 'ada', 'anthropic', 'claude-x', ?1, 1, 1, 0, 0, 1, 1, 'end_turn', 0)`,
      ).run(callType);
      db.query("INSERT INTO call_attempts (id, started_at, status, character, provider, model, call_type) VALUES (?1, '2026-11-01T00:00:00.000Z', 'done', 'ada', 'anthropic', 'claude-x', ?2)").run(id, callType);
      db.query("INSERT INTO capture_calls (call_id, ts, ts_unix, call_type) VALUES (?1, '2026-11-01T00:00:00.000Z', 1, ?2)").run(id, callType);
      db.query("INSERT INTO capture_transcripts (ts, ts_unix, source, call_type, entry_zstd) VALUES ('2026-11-01T00:00:00.000Z', 1, 'heartbeat', ?1, x'00')").run(callType);
      db.query("INSERT INTO capture_http_calls (call_id, seq, ts, ts_unix, call_type, method, url) VALUES (?1, 0, '2026-11-01T00:00:00.000Z', 1, ?2, 'POST', 'https://example.test')").run(id, callType);
    }
  } finally {
    db.close();
  }
}

function recorded(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(TABLES.map((table) => [table, db.query(`SELECT call_type FROM ${table} ORDER BY rowid`).values().flat()]));
  } finally {
    db.close();
  }
}

async function install(): Promise<{ data: string; path: string }> {
  const data = join(await mkdtemp(testTmp("shore-wake-names-")), "data");
  initializeDatabase(data);
  return { data, path: databasePath(data) };
}

test("calls recorded as heartbeats are recorded as wakes after the daemon's next start, everywhere a call's type is kept, once", async () => {
  const { data, path } = await install();
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  try {
    record(path, ["message", "heartbeat", "heartbeat_tool_loop", "dreaming_tool_loop", "wake"]);
    renameRecordedHeartbeatCalls(data);
    const now = ["message", "wake", "wake_tool_loop", "dreaming_tool_loop", "wake"];
    expect(recorded(path)).toEqual(Object.fromEntries(TABLES.map((table) => [table, now])));
    expect(said.mock.calls.map((call) => String(call[0]))).toEqual(["shore: 10 recorded wake calls had the call type heartbeat and now have wake; this happens once"]);

    record(path, ["heartbeat"]);
    renameRecordedHeartbeatCalls(data);
    expect(recorded(path)).toEqual(Object.fromEntries(TABLES.map((table) => [table, [...now, "heartbeat"]])));
    expect(said.mock.calls).toHaveLength(1);
  } finally {
    said.mockRestore();
  }
});

test("the Claude sessions that old wakes ran in are let go of, so their transcripts are cleared away, and every other session is kept", async () => {
  const { data, path } = await install();
  const session = (sessionId: string) => ({ version: SESSION_BOOK_VERSION, sessionId, entries: [] });
  const ledger = join(data, "shore.db");
  writeBook(bookPathIn(data), {
    [sessionKey("ada", ledger, "main")]: session("home"),
    [sessionKey("ada", ledger, "ring")]: session("thread"),
    [sessionKey("ada", ledger, "ring", "heartbeat")]: session("old-wake"),
    [sessionKey("ada", ledger, "main", "dreaming")]: session("dream"),
    [sessionKey("ada", ledger, "heartbeat")]: session("thread-named-heartbeat"),
    [sessionKey("ada", ledger, "heartbeat", "dreaming")]: session("dream-there"),
  });
  renameRecordedHeartbeatCalls(data);
  expect(Object.values(readBook(bookPathIn(data))).map((kept) => kept.sessionId).toSorted((a, b) => a.localeCompare(b))).toEqual(["dream", "dream-there", "home", "thread", "thread-named-heartbeat"]);
  const db = new Database(path, { readonly: true });
  try {
    const retired = db.query("SELECT path FROM state_files WHERE path GLOB 'sdk_retired/*'").values().flat().map((name) => Buffer.from(String(name).slice("sdk_retired/".length), "base64url").toString());
    expect(retired).toEqual(["old-wake"]);
  } finally {
    db.close();
  }
});

test("the rewrite runs when the daemon starts", async () => {
  const { data, path } = await install();
  record(path, ["heartbeat", "heartbeat_tool_loop"]);
  const root = join(data, "..");
  const config: LoadedConfig = {
    app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data, cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  try {
    const runtime = await createRuntime({ config, providers: {}, env: {} });
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
    expect(recorded(path)["calls"]).toEqual(["wake", "wake_tool_loop"]);
  } finally {
    said.mockRestore();
  }
});

test("an install with no heartbeat calls says nothing, and one whose database can't be changed is told and tried again at the next start", async () => {
  const quiet = await install();
  const said = spyOn(shoreLog, "info").mockImplementation(() => {});
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    record(quiet.path, ["message"]);
    renameRecordedHeartbeatCalls(quiet.data);
    expect([said.mock.calls, warned.mock.calls]).toEqual([[], []]);

    const broken = await install();
    record(broken.path, ["heartbeat"]);
    const db = new Database(broken.path);
    db.run("ALTER TABLE capture_http_calls RENAME TO capture_http_calls_elsewhere");
    db.close();
    renameRecordedHeartbeatCalls(broken.data);
    expect(warned.mock.calls.map((call) => String(call[0]).split(":").slice(0, 2).join(":"))).toEqual([
      "shore: could not rename the call type of recorded wake calls, so they stay heartbeat until a later start succeeds",
    ]);
    expect(new Database(broken.path, { readonly: true }).query("SELECT call_type FROM calls").values()).toEqual([["heartbeat"]]);

    const mended = new Database(broken.path);
    mended.run("ALTER TABLE capture_http_calls_elsewhere RENAME TO capture_http_calls");
    mended.close();
    closeStorageConnections();
    renameRecordedHeartbeatCalls(broken.data);
    expect(recorded(broken.path)["calls"]).toEqual(["wake"]);
  } finally {
    said.mockRestore();
    warned.mockRestore();
  }
});

test("a ledger from before calls recorded their trigger gains the column when it is opened, and records with it", async () => {
  const { path } = await install();
  const old = new Database(path);
  old.run("ALTER TABLE calls DROP COLUMN wake_trigger");
  old.close();
  const ledger = Ledger.open(path);
  try {
    ledger.record({
      provider: "anthropic", model: "claude-x", call_type: "wake", character: "ada", finish_reason: "end_turn", thinking_enabled: false, trigger: "lamp",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 },
    });
    ledger.record({
      provider: "anthropic", model: "claude-x", call_type: "message", character: "ada", finish_reason: "end_turn", thinking_enabled: false,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 },
    });
    expect(ledger.database.query("SELECT call_type, wake_trigger FROM calls ORDER BY id").values()).toEqual([["wake", "lamp"], ["message", null]]);
  } finally {
    ledger.close();
  }
});

test("a wake's calls and its tool-loop calls share one Claude session of their own, as a dream's do, apart from the conversation's", () => {
  const key = (callType: string | undefined, thread?: string): string => conversationKey({
    sdk: "claude_agent", model: "claude-x", api_key: "", messages: [], max_tokens: 1, reasoning_replay: "all",
    ...(callType === undefined ? {} : { context: { character: "ada", ledger: "/data/shore.db", call_type: callType, thinking_enabled: false, ...(thread === undefined ? {} : { thread }) } }),
  });
  const scope = (callType: string): string => key(callType).split("\u0000").slice(2).join("/");
  expect(["message", "tool_loop", "keepalive", "wake", "wake_tool_loop", "dreaming", "dreaming_tool_loop", "compaction"].map(scope))
    .toEqual(["", "", "", "main/wake", "main/wake", "main/dreaming", "main/dreaming", "main/compaction"]);
  expect([key("wake", "ring") === key("wake_tool_loop", "ring"), key("wake", "ring") === key("wake"), key("wake") === key("message")]).toEqual([true, false, false]);
});

test("a wake's first call may start cold, a follow-up that loses its cache is flagged, and so is a chat reply's", () => {
  const tracker = new CacheTracker(3600);
  const anomaly = (callType: string, read: number, write: number) => tracker.observe({
    ts: "2026-11-08T03:00:00Z", provider: "anthropic", sdk: "anthropic", model: "claude-fixture", thinking_enabled: false,
    cache_read_tokens: read, cache_write_tokens: write, call_type: callType,
  }).anomaly;
  expect([anomaly("message", 0, 10_000), anomaly("message", 10_000, 100), anomaly("wake", 0, 8_000), anomaly("wake_tool_loop", 8_000, 200), anomaly("wake_tool_loop", 0, 9_000)])
    .toEqual([undefined, undefined, undefined, undefined, "unexpected_write"]);
  expect([anomaly("message", 0, 10_000), anomaly("tool_loop", 10_000, 200), anomaly("tool_loop", 10_200, 200), anomaly("tool_loop", 0, 9_000)])
    .toEqual([undefined, undefined, undefined, "unexpected_write"]);
  expect([anomaly("message", 0, 10_000), anomaly("message", 10_000, 100), anomaly("message", 0, 9_000)]).toEqual([undefined, undefined, "unexpected_write"]);
});

test("a wake or its tool loop reading its own cache doesn't hide that the conversation's keepalive missed twice, while a reply reading it does", () => {
  const twice = (between: string): unknown[] => {
    const tracker = new CacheTracker(3600);
    const anomaly = (callType: string, read: number, write: number) => tracker.observe({
      ts: "2026-11-08T03:00:00Z", provider: "anthropic", sdk: "anthropic", model: "claude-fixture", thinking_enabled: false,
      cache_read_tokens: read, cache_write_tokens: write, call_type: callType,
    }).anomaly;
    anomaly("message", 0, 10_000);
    return [anomaly("keepalive", 0, 0), anomaly(between, 5_000, 100), anomaly("keepalive", 0, 0)];
  };
  expect(twice("wake")).toEqual(["cold_keepalive", undefined, "keepalive_double_miss"]);
  expect(twice("wake_tool_loop")).toEqual(["cold_keepalive", undefined, "keepalive_double_miss"]);
  expect(twice("message")).toEqual(["cold_keepalive", undefined, "cold_keepalive"]);
});
