import { Database } from "bun:sqlite";

export function memoryCoverageState(
  dbPath: string,
  character: string,
  path: string,
  version: string,
): { state: string; unit: string | null; claim: string | null } | undefined {
  const db = new Database(dbPath, { readwrite: true });
  try {
    const row = db
      .query("SELECT state, unit, claim FROM memory_coverage WHERE character = ?1 AND path = ?2 AND version = ?3")
      .get(character, path, version) as { state: string; unit: string | null; claim: string | null } | null;
    return row ?? undefined;
  } finally {
    db.close();
  }
}
