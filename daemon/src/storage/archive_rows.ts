import { Database, type SQLQueryBindings } from "bun:sqlite";

const CAPTURE_TABLES = ["capture_blobs", "capture_payloads", "capture_calls", "capture_transcripts", "capture_http_calls"];
const LEDGER_TABLES = ["calls", "call_attempts", "pricing", "pricing_catalog_checks", "usage_budget_warnings"];
export const HISTORY_TABLES = [
  "history_blobs", "history_segments", "history_messages", "history_alternatives", "history_pending",
  "history_thread_forks", "memory_coverage", "history_character_stats", "history_archive_revision",
];

type Row = Record<string, SQLQueryBindings>;
type Column = { name: string; pk: number; type: string };

export function copyArchiveTables(source: Database, destination: Database, kind: "history" | "ledger" | "capture"): void {
  const tables = kind === "capture" ? CAPTURE_TABLES : kind === "ledger" ? LEDGER_TABLES : HISTORY_TABLES;
  const mappings = new Map<string, Map<number, number>>();
  for (const table of tables) {
    const sourceColumns = new Set((source.query(`PRAGMA table_info(${table})`).all() as Column[]).map(column => column.name));
    const columns = (destination.query(`PRAGMA table_info(${table})`).all() as Column[]).filter(column => sourceColumns.has(column.name));
    const primary = columns.filter(column => column.pk > 0);
    const autoId = primary.length === 1 && primary[0]?.name === "id" && primary[0].type === "INTEGER";
    const names = columns.map(column => column.name).filter(name => !autoId || name !== "id");
    const ids = new Map<number, number>();
    mappings.set(table, ids);
    const insert = destination.query(`INSERT OR IGNORE INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
    for (const row of source.query(`SELECT ${columns.map(column => column.name).join(",")} FROM ${table} ORDER BY ${primary.map(column => column.name).join(",")}`).iterate() as Iterable<Row>) {
      const values = names.map(name => {
        const value = row[name] ?? null;
        const target = referenceTable(table, name);
        if (target === undefined || value === null) return value;
        const mapped = mappings.get(target)?.get(Number(value));
        if (mapped === undefined) throw new Error(`Orphaned archive reference: ${table}.${name}`);
        return mapped;
      });
      if (table === "history_archive_revision") {
        destination.query(`INSERT INTO history_archive_revision(character, revision) VALUES (?1, ?2)
          ON CONFLICT(character) DO UPDATE SET revision = max(revision, excluded.revision)`)
          .run(row["character"] ?? null, row["revision"] ?? null);
        continue;
      }
      const reused = table === "capture_payloads"
        ? destination.query(`SELECT id FROM ${table} WHERE ${names.map(name => `${name} IS ?`).join(" AND ")}`).get(...values) as { id: number } | null
        : null;
      const result = reused === null ? insert.run(...values) : { changes: 1, lastInsertRowid: reused.id };
      if (result.changes === 0) {
        const keys = primary.map(column => column.name);
        const retained = destination.query(`SELECT ${names.join(",")} FROM ${table} WHERE ${keys.map(name => `${name} IS ?`).join(" AND ")}`)
          .get(...keys.map(name => row[name] ?? null)) as Row | null;
        if (retained === null || JSON.stringify(names.map(name => retained[name])) !== JSON.stringify(values)) {
          throw new Error(`Conflicting archive row in ${table}`);
        }
      }
      if (autoId) ids.set(Number(row["id"]), Number(result.lastInsertRowid));
    }
  }
}

function referenceTable(table: string, column: string): string | undefined {
  if (table === "history_alternatives" && column === "message_id") return "history_messages";
  if (table === "call_attempts" && column === "call_id") return "calls";
  if ((table === "capture_calls" || table === "capture_http_calls") && (column === "request_payload_id" || column === "response_payload_id")) return "capture_payloads";
  return undefined;
}
