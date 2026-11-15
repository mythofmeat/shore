import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { closeStorageConnections, databasePath, insertEvent, pack, withStorage } from "../src/storage/store.ts";
import { appendDurableLine, readDurable, writeDurable } from "../src/storage/files.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { Ledger } from "../src/ledger/store.ts";
import type { Message } from "../src/engine/types.ts";
import { appendSubagentTrace, readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { exportUnifiedDatabase, importUnifiedDatabase, removeStoredCharacter } from "../src/storage/archive.ts";
import { handlesUnder } from "./support/handles.ts";

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "shore-storage-"));
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

describe("one character's slice of the database", () => {
  const NOW = "2026-09-01T00:00:00.000Z";
  const openHandles = (...roots: string[]): number => {
    closeStorageConnections();
    return roots.reduce((count, root) => count + handlesUnder(root), 0);
  };
  const message = (character: string): Message => ({
    msg_id: `m_${character}`,
    role: "assistant",
    content: `reply for ${character}`,
    content_blocks: [{ type: "text", text: `reply for ${character}` }],
    images: [],
    timestamp: NOW,
    alternatives: [{ content: `other reply for ${character}`, content_blocks: [{ type: "text", text: `other reply for ${character}` }], images: [], timestamp: NOW }],
  });
  const call = { provider: "openai", model: "gpt-test", call_type: "chat" };

  function seed(data: string, character: string): void {
    const path = databasePath(data);
    const history = HistoryStore.open(path);
    history.putSegment(character, 0, { file: "segment-0.jsonl", compacted_at: NOW }, [message(character)]);
    history.close();
    const ledger = Ledger.create(path, undefined, false);
    ledger.record({ ...call, character, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 }, finish_reason: "end_turn", thinking_enabled: false });
    ledger.beginAttempt({ ...call, character });
    ledger.close();
    const captures = CallStore.open(path);
    captures.recordCall({ call_id: `${character}-call`, ts: new Date(NOW), character, usage: ZERO_USAGE, request_body: JSON.stringify({ character, content: `a prompt from ${character} `.repeat(200) }) });
    captures.close();
    writeDurable(join(data, character, "notes.json"), `{"for":"${character}"}`);
    appendDurableLine(join(data, character, "log.jsonl"), `{"line":"${character}"}`);
    withStorage(data, (db) => {
      insertEvent(db, { character, kind: "test", timestamp: NOW, content: `event for ${character}` });
    });
  }

  function rows(path: string, sql: string): unknown[] {
    const db = new Database(path, { readonly: true });
    try {
      return db.query(sql).values().map((row) => row.length === 1 ? row[0] : row);
    } finally {
      db.close();
    }
  }

  function seeded(): ReturnType<typeof dirs> {
    const source = dirs();
    initializeDatabase(source.data);
    seed(source.data, "ada");
    seed(source.data, "bea");
    withStorage(source.data, (db) => {
      db.query("INSERT INTO pricing_catalog_checks (url, fetched_at) VALUES (?1, ?2)").run("https://example.test/models", 1);
    });
    return source;
  }

  function exported(name: string): { source: ReturnType<typeof dirs>; archive: string } {
    const source = seeded();
    const archive = join(source.root, `${name}.db`);
    exportUnifiedDatabase(databasePath(source.data), "ada", archive);
    return { source, archive };
  }

  test("an export carries only that character, keeps attempts in flight pending, and leaves nothing open or behind", () => {
    const source = seeded();
    const archive = join(source.root, "only-ada.db");
    const before = openHandles(source.root);
    exportUnifiedDatabase(databasePath(source.data), "ada", archive);
    expect([before, openHandles(source.root)]).toEqual([0, 0]);
    expect(readdirSync(source.root).filter((name) => name.includes(".draft"))).toEqual([]);
    expect(rows(archive, "SELECT DISTINCT character FROM history_messages")).toEqual(["ada"]);
    expect(rows(archive, "SELECT count(*) FROM history_alternatives")).toEqual([1]);
    expect(rows(archive, "SELECT count(*) FROM history_blobs")).toEqual([2]);
    expect(rows(archive, "SELECT character FROM calls")).toEqual(["ada"]);
    expect(rows(archive, "SELECT character, status FROM call_attempts")).toEqual([["ada", "pending"]]);
    expect(rows(archive, "SELECT character FROM capture_calls")).toEqual(["ada"]);
    expect(rows(archive, "SELECT count(*) FROM capture_payloads")).toEqual([1]);
    expect(rows(archive, "SELECT DISTINCT character FROM state_files")).toEqual(["ada"]);
    expect(rows(archive, "SELECT count(*) FROM state_lines")).toEqual([1]);
    expect(rows(archive, "SELECT character FROM events")).toEqual(["ada"]);
    expect(rows(archive, "SELECT count(*) FROM pricing_catalog_checks")).toEqual([0]);
  });

  test("a character with no database yet exports an empty one, and one made by the ledger alone gains the other tables", () => {
    const fresh = dirs();
    const empty = join(fresh.root, "empty.db");
    exportUnifiedDatabase(databasePath(fresh.data), "ada", empty);
    expect(rows(empty, "SELECT count(*) FROM state_files")).toEqual([0]);
    const ledgerOnly = dirs();
    Ledger.create(databasePath(ledgerOnly.data)).close();
    const archive = join(ledgerOnly.root, "ledger-only.db");
    exportUnifiedDatabase(databasePath(ledgerOnly.data), "ada", archive);
    expect(rows(archive, "SELECT count(*) FROM history_messages")).toEqual([0]);
  });

  test("an export exactly at the size limit passes, and one byte over it is refused", () => {
    const { source, archive } = exported("sized");
    const size = statSync(archive).size;
    exportUnifiedDatabase(databasePath(source.data), "ada", join(source.root, "at-limit.db"), size);
    expect(() => exportUnifiedDatabase(databasePath(source.data), "ada", join(source.root, "over-limit.db"), size - 1)).toThrow("Database snapshot exceeds the browser archive processing limit");
  });

  test("an import refuses another character's rows, and data the destination already holds for the character", () => {
    const { archive } = exported("refusals");
    const crowded = dirs();
    initializeDatabase(crowded.data);
    const mixed = join(crowded.root, "mixed.db");
    copyFileSync(archive, mixed);
    const db = new Database(mixed);
    db.query("UPDATE calls SET character = 'bea'").run();
    db.close();
    expect(() => importUnifiedDatabase(databasePath(crowded.data), mixed, "ada")).toThrow("archive database contains another character");
    const otherHistory = join(crowded.root, "other-history.db");
    copyFileSync(archive, otherHistory);
    const history = new Database(otherHistory);
    history.query("UPDATE history_segments SET character = 'bea'").run();
    history.close();
    expect(() => importUnifiedDatabase(databasePath(crowded.data), otherHistory, "ada")).toThrow("archive database contains another character");
    const withHistory = dirs();
    initializeDatabase(withHistory.data);
    const store = HistoryStore.open(databasePath(withHistory.data));
    store.putSegment("ada", 0, { file: "segment-0.jsonl", compacted_at: NOW }, [message("ada")]);
    store.close();
    expect(() => importUnifiedDatabase(databasePath(withHistory.data), archive, "ada")).toThrow("history already exists for ada");
    const withState = dirs();
    initializeDatabase(withState.data);
    writeDurable(join(withState.data, "ada", "left-behind.json"), "{}");
    expect(() => importUnifiedDatabase(databasePath(withState.data), archive, "ada")).toThrow("stored data already exists for ada");
  });

  test("an import refuses a collection or line nothing of the character's owns", () => {
    const { archive } = exported("orphans");
    const target = dirs();
    initializeDatabase(target.data);
    const orphanCollection = join(target.root, "orphan-collection.db");
    copyFileSync(archive, orphanCollection);
    const collections = new Database(orphanCollection);
    collections.query("INSERT INTO state_collections VALUES ('nobody/list.jsonl', 'jsonl')").run();
    collections.close();
    expect(() => importUnifiedDatabase(databasePath(target.data), orphanCollection, "ada")).toThrow("archive collection has no owned state file");
    const orphanLine = join(target.root, "orphan-line.db");
    copyFileSync(archive, orphanLine);
    const lines = new Database(orphanLine);
    lines.query("INSERT INTO state_lines VALUES ('nobody/list.jsonl', 0, NULL, ?1)").run(new Uint8Array([1]));
    lines.close();
    expect(() => importUnifiedDatabase(databasePath(target.data), orphanLine, "ada")).toThrow("archive row has no owned collection");
    expect(rows(databasePath(target.data), "SELECT count(*) FROM state_files")).toEqual([0]);
  });

  test("an import brings the character's lines, keeps others' attempts pending, leaves nothing open, and moves media paths only between two known folders", () => {
    const { source, archive } = exported("round-trip");
    const target = dirs();
    initializeDatabase(target.data);
    seed(target.data, "bea");
    const before = openHandles(target.root, source.root);
    importUnifiedDatabase(databasePath(target.data), archive, "ada", source.data);
    expect([before, openHandles(target.root, source.root)]).toEqual([0, 0]);
    expect(readDurable(join(target.data, "ada", "log.jsonl"))).toBe('{"line":"ada"}');
    expect(rows(databasePath(target.data), "SELECT character, status FROM call_attempts ORDER BY character")).toEqual([["ada", "pending"], ["bea", "pending"]]);
    const moved = dirs();
    initializeDatabase(moved.data);
    const pointing = join(moved.root, "pointing.db");
    copyFileSync(archive, pointing);
    const db = new Database(pointing);
    db.query("UPDATE state_files SET content = ?1 WHERE path LIKE '%notes.json'").run(pack(JSON.stringify({ picture: `${source.data}/media/ada/a.png` })));
    db.close();
    importUnifiedDatabase(databasePath(moved.data), pointing, "ada", source.data);
    expect(readDurable(join(moved.data, "ada", "notes.json"))).toBe(JSON.stringify({ picture: `${source.data}/media/ada/a.png` }));
  });

  test("an archive from when a wake's calls were recorded as heartbeats is imported with them recorded as wakes", () => {
    const source = seeded();
    const old = new Database(databasePath(source.data));
    old.run("UPDATE calls SET call_type = 'heartbeat_tool_loop' WHERE character = 'ada'");
    old.run("UPDATE call_attempts SET call_type = 'heartbeat' WHERE character = 'ada'");
    old.close();
    const archive = join(source.root, "old-ada.db");
    exportUnifiedDatabase(databasePath(source.data), "ada", archive);
    const target = dirs();
    initializeDatabase(target.data);
    seed(target.data, "bea");
    importUnifiedDatabase(databasePath(target.data), archive, "ada", source.data, target.data);
    expect(rows(databasePath(target.data), "SELECT character, call_type FROM calls ORDER BY character")).toEqual([["ada", "wake_tool_loop"], ["bea", "chat"]]);
    expect(rows(databasePath(target.data), "SELECT character, call_type FROM call_attempts ORDER BY character")).toEqual([["ada", "wake"], ["bea", "chat"]]);
  });

  test("removing a character takes its rows, alternatives, blobs and attempts, keeps the others', leaves nothing open, and works on a database the history store made alone", () => {
    const shared = dirs();
    initializeDatabase(shared.data);
    seed(shared.data, "ada");
    seed(shared.data, "bea");
    const path = databasePath(shared.data);
    const before = openHandles(shared.root);
    removeStoredCharacter(path, "ada");
    expect([before, openHandles(shared.root)]).toEqual([0, 0]);
    expect(rows(path, "SELECT DISTINCT character FROM history_messages")).toEqual(["bea"]);
    expect(rows(path, "SELECT count(*) FROM history_alternatives")).toEqual([1]);
    expect(rows(path, "SELECT count(*) FROM history_blobs")).toEqual([2]);
    expect(rows(path, "SELECT character, status FROM call_attempts")).toEqual([["bea", "pending"]]);
    expect(rows(path, "SELECT character FROM calls")).toEqual(["bea"]);
    expect(rows(path, "SELECT DISTINCT character FROM capture_calls")).toEqual(["bea"]);
    const historyOnly = dirs();
    HistoryStore.open(databasePath(historyOnly.data)).close();
    removeStoredCharacter(databasePath(historyOnly.data), "ada");
    expect(rows(databasePath(historyOnly.data), "SELECT count(*) FROM call_attempts")).toEqual([0]);
  });
});
