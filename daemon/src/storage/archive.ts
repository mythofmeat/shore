import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CallStore } from "../call_store.ts";
import { CHARACTER_ARCHIVES_SQL, HistoryStore } from "../engine/history_store.ts";
import { Ledger } from "../ledger/store.ts";
import { mergeTables, HISTORY_TABLES } from "./migrate.ts";
import { openStorage, pack, unpack, STORAGE_SCHEMA } from "./store.ts";

export function exportUnifiedDatabase(path: string, character: string, output: string, maxBytes?: number): void {
  if (!existsSync(path)) openStorage(dirname(path)).close();
  const source = new Database(path, { readonly: true });
  try {
    if (maxBytes !== undefined) {
      const pageCount = source.query("PRAGMA page_count").get() as { page_count: number };
      const pageSize = source.query("PRAGMA page_size").get() as { page_size: number };
      if (pageCount.page_count * pageSize.page_size > maxBytes) throw new Error("Database snapshot exceeds the browser archive processing limit");
    }
    writeFileSync(output, source.serialize());
  }
  finally { source.close(); }
  CallStore.open(output).close();
  Ledger.create(output, undefined, false).close();
  HistoryStore.open(output).close();
  const copy = new Database(output);
  copy.run(STORAGE_SCHEMA);
  try {
    copy.run("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF");
    copy.query(`DELETE FROM history_alternatives WHERE message_id NOT IN
      (SELECT id FROM history_messages WHERE ${CHARACTER_ARCHIVES_SQL})`).run(character);
    for (const table of HISTORY_TABLES.filter((name) => !["history_blobs", "history_alternatives", "history_metadata"].includes(name))) {
      copy.query(`DELETE FROM ${table} WHERE NOT ${CHARACTER_ARCHIVES_SQL}`).run(character);
    }
    for (const table of ["calls", "call_attempts", "capture_calls", "capture_http_calls", "capture_transcripts", "state_files", "events"]) {
      copy.query(`DELETE FROM ${table} WHERE character IS NOT ?1`).run(character);
    }
    copy.run(`DELETE FROM pricing; DELETE FROM pricing_catalog_checks; DELETE FROM usage_budget_warnings;
      DELETE FROM storage_imports; DELETE FROM storage_import_rows;
      DELETE FROM history_metadata;
      DELETE FROM history_blobs WHERE hash NOT IN
        (SELECT blocks_hash FROM history_messages UNION SELECT blocks_hash FROM history_alternatives);`);
  } finally { copy.close(); }
  const capture = CallStore.open(output);
  try { capture.collectUnusedPayloads(); }
  finally { capture.close(); }
  const compacted = new Database(output);
  try { compacted.run("PRAGMA journal_mode = DELETE; VACUUM;"); }
  finally { compacted.close(); }
}

export function importUnifiedDatabase(path: string, sourcePath: string, character: string, sourceData?: string, destinationData?: string): void {
  openStorage(dirname(path)).close();
  CallStore.open(path).close();
  Ledger.create(path, undefined, false).close();
  HistoryStore.open(path).close();
  const source = new Database(sourcePath, { readonly: true });
  const destination = new Database(path);
  try {
    const scoped = ["calls", "call_attempts", "capture_calls", "capture_http_calls", "capture_transcripts", "state_files", "events"];
    for (const table of scoped) {
      if (source.query(`SELECT 1 FROM ${table} WHERE character IS NOT ?1 LIMIT 1`).get(character) !== null) {
        throw new Error("archive database contains another character");
      }
    }
    for (const table of HISTORY_TABLES.filter((name) => !["history_blobs", "history_alternatives", "history_metadata"].includes(name))) {
      if (source.query(`SELECT 1 FROM ${table} WHERE NOT ${CHARACTER_ARCHIVES_SQL} LIMIT 1`).get(character) !== null) {
        throw new Error("archive database contains another character");
      }
    }
    for (const table of ["history_segments", "history_messages"]) {
      if (destination.query(`SELECT 1 FROM ${table} WHERE ${CHARACTER_ARCHIVES_SQL} LIMIT 1`).get(character) !== null) throw new Error(`history already exists for ${character}`);
    }
    for (const table of scoped) {
      if (destination.query(`SELECT 1 FROM ${table} WHERE character = ?1 LIMIT 1`).get(character) !== null) throw new Error(`stored data already exists for ${character}`);
    }
    destination.transaction(() => {
      for (const kind of ["history", "ledger", "capture"] as const) {
        const namespace = `archive:${crypto.randomUUID()}:${kind}`;
        mergeTables(source, destination, kind, sourcePath, namespace);
        destination.query("DELETE FROM storage_import_rows WHERE kind = ?1").run(namespace);
      }
      for (const row of source.query("SELECT path, character, content FROM state_files").iterate() as Iterable<{ path: string; character: string; content: Uint8Array }>) {
        destination.query("INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)").run(row.path, row.character, row.content);
      }
      if (source.query("SELECT 1 FROM sqlite_master WHERE name = 'state_collections'").get() !== null) {
        for (const row of source.query("SELECT path, format FROM state_collections").all() as { path: string; format: string }[]) {
          if (destination.query("SELECT 1 FROM state_files WHERE path = ?1 AND character = ?2").get(row.path, character) === null) throw new Error("archive collection has no owned state file");
          destination.query("INSERT INTO state_collections VALUES (?1, ?2)").run(row.path, row.format);
        }
        for (const row of source.query("SELECT path, seq, entry_key, content FROM state_lines").iterate() as Iterable<{ path: string; seq: number; entry_key: string | null; content: Uint8Array }>) {
          if (destination.query("SELECT 1 FROM state_collections WHERE path = ?1").get(row.path) === null) throw new Error("archive row has no owned collection");
          destination.query("INSERT INTO state_lines VALUES (?1, ?2, ?3, ?4)").run(row.path, row.seq, row.entry_key, row.content);
        }
      }
      for (const row of source.query("SELECT character, kind, event_key, timestamp, content FROM events ORDER BY id").iterate() as Iterable<{ character: string; kind: string; event_key: string | null; timestamp: string; content: Uint8Array }>) {
        destination.query("INSERT INTO events(character, kind, event_key, timestamp, content) VALUES (?1, ?2, ?3, ?4, ?5)")
          .run(row.character, row.kind, row.event_key, row.timestamp, row.content);
      }
      if (sourceData !== undefined && destinationData !== undefined && sourceData !== destinationData) {
        relocateMediaReferences(destination, character, sourceData, destinationData);
      }
    })();
  } finally { source.close(); destination.close(); }
}

function relocateMediaReferences(db: Database, character: string, from: string, to: string): void {
  const rewrite = (content: string) => {
    let next = content;
    for (const source of [`${from}/${character}/images`, `${from}/media/${character}`]) {
      const target = `${to}/media/${character}`;
      next = next.replaceAll(JSON.stringify(source).slice(1, -1), JSON.stringify(target).slice(1, -1));
    }
    return next;
  };
  for (const row of db.query("SELECT path FROM state_files WHERE character = ?1 AND path LIKE 'sdk_sessions/%'").all(character) as { path: string }[]) {
    const at = row.path.lastIndexOf("/") + 1;
    const parts = Buffer.from(row.path.slice(at), "base64url").toString().split("\u0000");
    if (parts[1] === `${from}/shore.db` || parts[1] === `${from}/ledger.db`) {
      parts[1] = `${to}/shore.db`;
      db.query("UPDATE state_files SET path = ?1 WHERE path = ?2").run(row.path.slice(0, at) + Buffer.from(parts.join("\u0000")).toString("base64url"), row.path);
    }
  }
  for (const table of ["state_files", "events"]) {
    const key = table === "state_files" ? "path" : "id";
    for (const row of db.query(`SELECT ${key} AS key, content FROM ${table} WHERE character = ?1`).all(character) as { key: string | number; content: Uint8Array }[]) {
      const old = unpack(row.content);
      const content = rewrite(old);
      if (old !== content) db.query(`UPDATE ${table} SET content = ?1 WHERE ${key} = ?2`).run(pack(content), row.key);
    }
  }
  for (const row of db.query("SELECT path, seq, content FROM state_lines WHERE path IN (SELECT path FROM state_files WHERE character = ?1)").iterate(character) as Iterable<{ path: string; seq: number; content: Uint8Array }>) {
    const before = unpack(row.content);
    const after = rewrite(before);
    if (before !== after) db.query("UPDATE state_lines SET content = ?1 WHERE path = ?2 AND seq = ?3").run(pack(after), row.path, row.seq);
  }
  for (const table of ["history_messages", "history_alternatives"]) {
    const condition = table === "history_messages" ? CHARACTER_ARCHIVES_SQL : `message_id IN (SELECT id FROM history_messages WHERE ${CHARACTER_ARCHIVES_SQL})`;
    for (const row of db.query(`SELECT rowid AS id, images FROM ${table} WHERE ${condition} AND images IS NOT NULL`).all(character) as { id: number; images: string }[]) {
      db.query(`UPDATE ${table} SET images = ?1 WHERE rowid = ?2`).run(rewrite(row.images), row.id);
    }
  }
}

export function removeStoredCharacter(path: string, character: string): void {
  HistoryStore.open(path).close();
  Ledger.create(path, undefined, false).close();
  const db = openStorage(dirname(path));
  try {
    db.transaction(() => {
      db.query("DELETE FROM state_files WHERE character = ?1").run(character);
      db.query("DELETE FROM events WHERE character = ?1").run(character);
    })();
  } finally { db.close(); }
  const capture = CallStore.open(path);
  try { capture.forgetCharacter(character); }
  finally { capture.close(); }
}
