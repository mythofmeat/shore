import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CallStore } from "../call_store.ts";
import type { ShoreDirs } from "../config/dirs.ts";
import { HistoryStore, OBSOLETE_RETENTION_COLUMNS } from "../engine/history_store.ts";
import { Ledger } from "../ledger/store.ts";
import { databasePath, openStorage, pack } from "./store.ts";

export const CAPTURE_TABLES = ["capture_blobs", "capture_payloads", "capture_calls", "capture_transcripts", "capture_http_calls"];
export const LEDGER_TABLES = ["calls", "call_attempts", "pricing", "pricing_catalog_checks", "usage_budget_warnings"];
export const HISTORY_TABLES = [
  "history_blobs", "history_segments", "history_messages", "history_alternatives", "history_pending",
  "history_thread_forks", "memory_coverage", "history_metadata",
  "history_character_stats", "history_archive_revision",
];

type Row = Record<string, SQLQueryBindings>;
type Column = { name: string; pk: number; type: string };
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

export function migrateDatabases(dirs: Pick<ShoreDirs, "data" | "cache">): void {
  const destination = openStorage(dirs.data);
  try {
    const path = databasePath(dirs.data);
    CallStore.open(path).close();
    Ledger.create(path, undefined, false).close();
    HistoryStore.open(path).close();
    for (const [kind, sources] of [
      ["history", [join(dirs.data, "history.db")]],
      ["ledger", [join(dirs.data, "ledger.db"), join(dirs.cache, "ledger.db")]],
      ["capture", [join(dirs.cache, "calls.db"), join(dirs.data, "calls.db")]],
    ] as const) {
      for (const source of new Set(sources)) {
        if (!existsSync(source)) continue;
        migrateDatabase(destination, source, kind, dirs.data);
      }
    }
  } finally {
    destination.close();
  }
}

function migrateDatabase(destination: Database, sourcePath: string, kind: "history" | "ledger" | "capture", data: string): void {
  if (statSync(sourcePath).size === 0) {
    if (SIDECAR_SUFFIXES.some((suffix) => existsSync(`${sourcePath}${suffix}`) && statSync(`${sourcePath}${suffix}`).size > 0)) {
      throw new Error(`Empty database has nonempty recovery files: ${sourcePath}; refusing to discard them`);
    }
    retireDatabase(sourcePath);
    return;
  }
  const source = new Database(sourcePath, { readonly: true });
  let snapshot: Uint8Array;
  try {
    const names = (source.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    const expected = kind === "history" ? "history_messages" : kind === "ledger" ? "calls" : names.includes("capture_calls") ? "capture_calls" : "calls";
    if (!names.includes(expected)) throw new Error(`Unrecognized ${kind} database: ${sourcePath}`);
    const integrity = source.query("PRAGMA quick_check").get() as Record<string, unknown>;
    if (Object.values(integrity)[0] !== "ok") throw new Error(`Cannot migrate damaged database ${sourcePath}`);
    snapshot = source.serialize();
  } finally {
    source.close();
  }
  const digest = createHash("sha256").update(snapshot).digest("hex");
  const imported = destination.query("SELECT digest FROM storage_imports WHERE source = ?1").get(sourcePath) as { digest: string } | null;
  if (imported !== null && imported.digest !== digest) {
    throw new Error(`Previously imported database changed: ${sourcePath}; refusing to discard new records`);
  }
  if (imported === null) {
    const stage = mkdtempSync(join(data, ".storage-migration-"));
    try {
      const temporary = join(stage, "source.db");
      writeFileSync(temporary, snapshot);
      if (kind === "capture") CallStore.open(temporary).close();
      else if (kind === "ledger") Ledger.create(temporary, undefined, false).close();
      else HistoryStore.open(temporary).close();
      const prepared = new Database(temporary, { readonly: true });
      try {
        const allowed = kind === "capture" ? CAPTURE_TABLES : kind === "ledger" ? LEDGER_TABLES : HISTORY_TABLES;
        const unexpected = (prepared.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).filter((row) => !allowed.includes(row.name) && !row.name.startsWith("sqlite_"));
        if (unexpected.length > 0) throw new Error(`Unrecognized tables in ${sourcePath}: ${unexpected.map((row) => row.name).join(", ")}`);
        destination.transaction(() => {
          mergeTables(prepared, destination, kind, sourcePath);
          destination.query("INSERT INTO storage_imports(source, digest) VALUES (?1, ?2)").run(sourcePath, digest);
        })();
      } finally {
        prepared.close();
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  retireDatabase(sourcePath);
}

function retireDatabase(sourcePath: string): void {
  unlinkSync(sourcePath);
  for (const suffix of SIDECAR_SUFFIXES) rmSync(`${sourcePath}${suffix}`, { force: true });
}

export function mergeTables(source: Database, destination: Database, kind: "history" | "ledger" | "capture", origin: string, namespace = kind as string): void {
  const tables = kind === "capture" ? CAPTURE_TABLES : kind === "ledger" ? LEDGER_TABLES : HISTORY_TABLES;
  const mappings = new Map<string, Map<number, number>>();
  for (const table of tables) {
    const columns = (source.query(`PRAGMA table_info(${table})`).all() as Column[])
      .filter((column) => table !== "history_segments" || !OBSOLETE_RETENTION_COLUMNS.has(column.name));
    if (columns.length === 0) continue;
    const primary = columns.filter((c) => c.pk > 0);
    const autoId = primary.length === 1 && primary[0]?.name === "id" && primary[0].type === "INTEGER";
    const names = columns.map((c) => c.name).filter((name) => !autoId || name !== "id");
    const ids = new Map<number, number>();
    mappings.set(table, ids);
    const occurrences = new Map<string, number>();
    const insert = destination.query(`INSERT OR IGNORE INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
    for (const row of source.query(`SELECT * FROM ${table} ORDER BY ${primary.map((c) => c.name).join(",") || "rowid"}`).iterate() as Iterable<Row>) {
      if (table === "memory_coverage" && row["path"] === "hindsight") continue;
      const values = names.map((name) => {
        const value = row[name] ?? null;
        const target = referenceTable(table, name);
        if (target === undefined || value === null) return value;
        const mapped = mappings.get(target)?.get(Number(value));
        if (mapped === undefined) throw new Error(`Orphaned ${table}.${name} in ${origin}`);
        return mapped;
      });
      const digest = createHash("sha256").update(JSON.stringify(values)).digest("hex");
      const digestBytes = Buffer.from(digest, "hex");
      const occurrence = (occurrences.get(digest) ?? 0) + 1;
      occurrences.set(digest, occurrence);
      const existing = destination.query(`SELECT target_id FROM storage_import_rows
        WHERE kind = ?1 AND table_name = ?2 AND digest = ?3 AND occurrence = ?4`)
        .get(namespace, table, digestBytes, occurrence) as { target_id: number | null } | null;
      let targetId = existing?.target_id ?? null;
      if (existing === null) {
        const reused = table === "capture_payloads"
          ? destination.query(`SELECT id FROM ${table} WHERE ${names.map((name) => `${name} IS ?`).join(" AND ")}`).get(...values) as { id: number } | null
          : null;
        const result = reused === null ? insert.run(...values) : { changes: 1, lastInsertRowid: reused.id };
        if (result.changes > 0) {
          targetId = autoId ? Number(result.lastInsertRowid) : null;
        } else {
          const keys = autoId ? names : primary.map((c) => c.name);
          const keyValues = keys.map((name) => values[names.indexOf(name)] ?? null);
          const retained = destination.query(`SELECT * FROM ${table} WHERE ${keys.map((name) => `${name} IS ?`).join(" AND ")}`).get(...keyValues) as Row | null;
          if (retained === null) throw new Error(`Unresolved conflict migrating ${table} from ${origin}`);
          if (autoId) targetId = Number(retained["id"]);
          if (JSON.stringify(names.map((name) => retained[name])) !== JSON.stringify(values)) {
            destination.query("INSERT OR IGNORE INTO state_files(path, character, content) VALUES (?1, ?2, ?3)")
              .run(`legacy/conflicts/${kind}/${table}/${digest}`, typeof row["character"] === "string" ? row["character"].split("/")[0] ?? "" : "", pack(JSON.stringify({ origin, table, row })));
          }
        }
        destination.query(`INSERT INTO storage_import_rows(kind, table_name, digest, occurrence, target_id)
          VALUES (?1, ?2, ?3, ?4, ?5)`).run(namespace, table, digestBytes, occurrence, targetId);
      }
      if (autoId && targetId !== null) ids.set(Number(row["id"]), targetId);
    }
  }
}

function referenceTable(table: string, column: string): string | undefined {
  if (table === "history_alternatives" && column === "message_id") return "history_messages";
  if (table === "call_attempts" && column === "call_id") return "calls";
  if ((table === "capture_calls" || table === "capture_http_calls") && (column === "request_payload_id" || column === "response_payload_id")) return "capture_payloads";
  return undefined;
}
