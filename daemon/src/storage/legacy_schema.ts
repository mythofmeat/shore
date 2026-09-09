import { Database } from "bun:sqlite";

type Column = { name: string };

export function renameLegacyCaptureTables(db: Database): void {
  const columns = db.query("PRAGMA table_info(calls)").all() as Column[];
  if (!columns.some((c) => c.name === "call_id")) return;
  db.transaction(() => {
    for (const name of ["calls", "transcripts", "http_calls", "blobs", "payloads"]) {
      if ((db.query(`PRAGMA table_info(${name})`).all()).length === 0) continue;
      const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL").all(name) as { name: string }[];
      for (const index of indexes) db.run(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
      db.run(`ALTER TABLE ${name} RENAME TO capture_${name}`);
    }
  })();
}
