import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { databasePath, withStorage } from "../src/storage/store.ts";
import { appendSubagentTrace, readSubagentTraces } from "../src/tools/subagent_trace.ts";
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
