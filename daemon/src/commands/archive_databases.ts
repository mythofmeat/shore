import { HISTORY_TABLES, LEDGER_TABLES } from "../storage/migrate.ts";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { writeFileSync } from "node:fs";

import { CHARACTER_ARCHIVES_SQL, HistoryStore, OBSOLETE_RETENTION_COLUMNS } from "../engine/history_store.ts";
import { Ledger } from "../ledger/store.ts";

type Row = Record<string, SQLQueryBindings>;

const CHARACTER_SCOPED_TABLES = [
  "history_messages",
  "history_segments",
  "history_pending",
  "history_character_stats",
  "history_archive_revision",
  "history_thread_forks",
  "memory_coverage",
] as const;

export function exportHistoryDatabase(path: string, character: string, output: string): void {
  const opened = HistoryStore.open(path);
  opened.close();
  const source = new Database(path, { readonly: true });
  writeFileSync(output, source.serialize());
  source.close();
  const copy = new Database(output, { create: false, readwrite: true });
  copy.run("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF");
  keepTables(copy, HISTORY_TABLES);
  copy.query(
    `DELETE FROM history_alternatives
       WHERE message_id IN (SELECT id FROM history_messages WHERE NOT ${CHARACTER_ARCHIVES_SQL})`,
  ).run(character);
  for (const table of CHARACTER_SCOPED_TABLES) {
    copy.query(`DELETE FROM ${table} WHERE NOT ${CHARACTER_ARCHIVES_SQL}`).run(character);
  }
  copy.run(
    `DELETE FROM history_blobs
       WHERE hash NOT IN (SELECT blocks_hash FROM history_messages
                          UNION SELECT blocks_hash FROM history_alternatives)`,
  );
  copy.run("DELETE FROM history_metadata; VACUUM;");
  copy.close();
}

export function exportLedgerDatabase(path: string, character: string, output: string): void {
  Ledger.create(path, undefined, false).close();
  const source = new Database(path, { readonly: true });
  writeFileSync(output, source.serialize());
  source.close();
  const copy = new Database(output, { create: false, readwrite: true });
  copy.run("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF");
  keepTables(copy, LEDGER_TABLES);
  copy.query("DELETE FROM call_attempts WHERE character != ?1").run(character);
  copy.query("DELETE FROM calls WHERE character != ?1").run(character);
  copy.run("DELETE FROM pricing; DELETE FROM usage_budget_warnings; VACUUM;");
  copy.close();
}

export function importHistoryDatabase(
  destinationPath: string,
  sourcePath: string,
  character: string,
): void {
  const initialized = HistoryStore.open(destinationPath);
  initialized.close();
  const destination = new Database(destinationPath, { create: true, readwrite: true });
  const source = new Database(sourcePath, { readonly: true });
  try {
    for (const table of CHARACTER_SCOPED_TABLES) {
      if (!hasTable(source, table)) continue;
      const other = source.query(`SELECT 1 FROM ${table} WHERE NOT ${CHARACTER_ARCHIVES_SQL} LIMIT 1`).get(character);
      if (other !== null) throw new Error("archive database contains another character");
    }
    const exists = destination
      .query(
        `SELECT 1 FROM history_segments WHERE ${CHARACTER_ARCHIVES_SQL}
         UNION ALL SELECT 1 FROM history_messages WHERE ${CHARACTER_ARCHIVES_SQL} LIMIT 1`,
      )
      .get(character);
    if (exists !== null) throw new Error(`history already exists for ${character}`);

    destination.transaction(() => {
      copyRows(source, destination, "history_blobs", undefined, "OR IGNORE");
      copyRows(source, destination, "history_segments", CHARACTER_ARCHIVES_SQL, "", character);
      copyRows(source, destination, "history_pending", CHARACTER_ARCHIVES_SQL, "", character);
      copyRows(source, destination, "history_character_stats", CHARACTER_ARCHIVES_SQL, "", character);
      for (const table of ["history_thread_forks", "memory_coverage"]) {
        if (!hasTable(source, table)) continue;
        const scope = table === "memory_coverage"
          ? `(${CHARACTER_ARCHIVES_SQL}) AND path != 'hindsight'`
          : CHARACTER_ARCHIVES_SQL;
        copyRows(source, destination, table, scope, "OR IGNORE", character);
      }

      const ids = new Map<number, number>();
      const messages = source
        .query(`SELECT * FROM history_messages WHERE ${CHARACTER_ARCHIVES_SQL} ORDER BY id`)
        .all(character) as Row[];
      const messageColumns = columnsOf(source, "history_messages").filter((column) => column !== "id");
      const insertMessage = inserter(destination, "history_messages", messageColumns);
      for (const row of messages) {
        const oldId = number(row["id"]);
        const inserted = insertMessage.run(...messageColumns.map((column) => binding(row, column)));
        ids.set(oldId, Number(inserted.lastInsertRowid));
      }

      const alternativeColumns = columnsOf(source, "history_alternatives");
      const insertAlternative = inserter(destination, "history_alternatives", alternativeColumns);
      for (const row of source.query("SELECT * FROM history_alternatives ORDER BY message_id, ordinal").all() as Row[]) {
        const mapped = ids.get(number(row["message_id"]));
        if (mapped === undefined) throw new Error("archive contains an orphaned message alternative");
        insertAlternative.run(
          ...alternativeColumns.map((column) =>
            column === "message_id" ? mapped : binding(row, column)
          ),
        );
      }

      for (const revision of source.query(
        `SELECT character, revision FROM history_archive_revision WHERE ${CHARACTER_ARCHIVES_SQL}`,
      ).all(character) as Row[]) {
        destination.query(
          `INSERT INTO history_archive_revision(character, revision) VALUES (?1, ?2)
             ON CONFLICT(character) DO UPDATE SET revision = excluded.revision`,
        ).run(binding(revision, "character"), binding(revision, "revision"));
      }

      destination.query(
        "DELETE FROM memory_coverage WHERE character = ?1 AND state = 'claimed'",
      ).run(character);
    })();
  } finally {
    source.close();
    destination.close();
  }
}

export function importLedgerDatabase(
  destinationPath: string,
  sourcePath: string,
  character: string,
): void {
  Ledger.create(destinationPath, undefined, false).close();
  const destination = new Database(destinationPath, { create: true, readwrite: true });
  const source = new Database(sourcePath, { readonly: true });
  try {
    requireOnlyCharacter(source, "calls", character);
    const exists = destination
      .query("SELECT 1 FROM calls WHERE character = ?1 LIMIT 1")
      .get(character);
    if (exists !== null) throw new Error(`ledger already exists for ${character}`);

    destination.transaction(() => {
      const ids = new Map<number, number>();
      const callColumns = columnsOf(source, "calls").filter((column) => column !== "id");
      const insertCall = inserter(destination, "calls", callColumns);
      for (const row of source.query("SELECT * FROM calls WHERE character = ?1 ORDER BY id").all(character) as Row[]) {
        const inserted = insertCall.run(...callColumns.map((column) => binding(row, column)));
        ids.set(number(row["id"]), Number(inserted.lastInsertRowid));
      }

      const attemptColumns = columnsOf(source, "call_attempts");
      const insertAttempt = inserter(destination, "call_attempts", attemptColumns, "OR IGNORE");
      for (const row of source.query("SELECT * FROM call_attempts WHERE character = ?1").all(character) as Row[]) {
        const oldCall = row["call_id"];
        const mapped = typeof oldCall === "number" ? ids.get(oldCall) ?? null : null;
        insertAttempt.run(
          ...attemptColumns.map((column) =>
            column === "call_id" ? mapped : binding(row, column)
          ),
        );
      }
    })();
  } finally {
    source.close();
    destination.close();
  }
}

export function removeCharacterDatabaseRows(
  historyPath: string,
  ledgerPath: string,
  character: string,
  remove: { history: boolean; ledger: boolean },
): void {
  if (remove.history) {
    const history = new Database(historyPath, { create: true, readwrite: true });
    history.transaction(() => {
      history.query(
        `DELETE FROM history_alternatives
           WHERE message_id IN (SELECT id FROM history_messages WHERE ${CHARACTER_ARCHIVES_SQL})`,
      ).run(character);
      for (const table of CHARACTER_SCOPED_TABLES) {
        history.query(`DELETE FROM ${table} WHERE ${CHARACTER_ARCHIVES_SQL}`).run(character);
      }
      history.run(
        `DELETE FROM history_blobs
           WHERE hash NOT IN (SELECT blocks_hash FROM history_messages
                              UNION SELECT blocks_hash FROM history_alternatives)`,
      );
    })();
    history.close();
  }

  if (remove.ledger) {
    const ledger = new Database(ledgerPath, { create: true, readwrite: true });
    ledger.transaction(() => {
      ledger.query("DELETE FROM call_attempts WHERE character = ?1").run(character);
      ledger.query("DELETE FROM calls WHERE character = ?1").run(character);
    })();
    ledger.close();
  }
}

function hasTable(db: Database, table: string): boolean {
  return db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
    .get(table) !== null;
}

function requireOnlyCharacter(db: Database, table: string, character: string): void {
  const other = db
    .query(`SELECT character FROM ${table} WHERE character != ?1 LIMIT 1`)
    .get(character) as Row | null;
  if (other !== null) throw new Error(`archive database contains another character`);
}

function copyRows(
  source: Database,
  destination: Database,
  table: string,
  where?: string,
  conflict = "",
  ...params: SQLQueryBindings[]
): void {
  const columns = columnsOf(source, table);
  const insert = inserter(destination, table, columns, conflict);
  const suffix = where === undefined ? "" : ` WHERE ${where}`;
  for (const row of source.query(`SELECT * FROM ${table}${suffix}`).all(...params) as Row[]) {
    insert.run(...columns.map((column) => binding(row, column)));
  }
}

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Row[])
    .map((row) => {
      const name = row["name"];
      if (typeof name !== "string") throw new Error(`archive has a malformed ${table} schema`);
      return name;
    })
    .filter((name) => table !== "history_segments" || !OBSOLETE_RETENTION_COLUMNS.has(name));
}

function inserter(db: Database, table: string, columns: readonly string[], conflict = "") {
  const placeholders = columns.map((_, index) => `?${String(index + 1)}`).join(", ");
  return db.query(
    `INSERT ${conflict} INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
  );
}

function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("archive database has a malformed numeric id");
  return value;
}

function binding(row: Row, column: string): SQLQueryBindings {
  return row[column] ?? null;
}

function keepTables(db: Database, allowed: readonly string[]): void {
  for (const row of db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    if (!allowed.includes(row.name) && !row.name.startsWith("sqlite_")) db.run(`DROP TABLE "${row.name.replaceAll('"', '""')}"`);
  }
}
