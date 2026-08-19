import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { hostZone } from "../src/ledger/zoned.ts";
import { classifyTimestamp, normalizeLegacyTimestamp } from "./legacy_timestamps.ts";

interface Tally {
  converted: number;
  canonical: number;
  unrecognized: string[];
}

const [dataDir, cacheDir, zoneArg] = process.argv.slice(2);
if (dataDir === undefined || cacheDir === undefined) {
  console.error("usage: bun run scripts/migrate_legacy_timestamps.ts <data-dir> <cache-dir> [timezone]");
  process.exit(2);
}
const zone = zoneArg ?? hostZone();

const dbPath = join(dataDir, "history.db");
if (!existsSync(dbPath)) {
  console.error(`no history.db at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readwrite: true });
db.run("PRAGMA busy_timeout = 5000;");

const messages = plan(
  db.query("SELECT id, timestamp FROM history_messages").all() as { id: number; timestamp: string }[],
  (row) => [row.id],
);
const alternatives = plan(
  db.query("SELECT message_id, ordinal, timestamp FROM history_alternatives").all() as {
    message_id: number;
    ordinal: number;
    timestamp: string;
  }[],
  (row) => [row.message_id, row.ordinal],
);

db.transaction(() => {
  const putMessage = db.query("UPDATE history_messages SET timestamp = ?2 WHERE id = ?1");
  for (const [key, timestamp] of messages.updates) putMessage.run(key[0], timestamp);
  const putAlternative = db.query(
    "UPDATE history_alternatives SET timestamp = ?3 WHERE message_id = ?1 AND ordinal = ?2",
  );
  for (const [key, timestamp] of alternatives.updates) {
    putAlternative.run(key[0], key[1], timestamp);
  }
})();
db.close();

console.log(`timezone: ${zone}`);
report("history_messages", messages.tally);
report("history_alternatives", alternatives.tally);

for (const index of searchIndexes(cacheDir)) {
  const cache = new Database(index, { readwrite: true });
  cache.run("PRAGMA busy_timeout = 5000;");
  cache.query("DELETE FROM metadata WHERE key = 'source_fingerprint'").run();
  cache.close();
  console.log(`invalidated ${index}`);
}

function plan<T extends { timestamp: string }>(
  rows: T[],
  keyOf: (row: T) => number[],
): { updates: [number[], string][]; tally: Tally } {
  const updates: [number[], string][] = [];
  const tally: Tally = { converted: 0, canonical: 0, unrecognized: [] };
  for (const row of rows) {
    if (classifyTimestamp(row.timestamp) === "rfc3339") {
      tally.canonical += 1;
      continue;
    }
    const normalized = normalizeLegacyTimestamp(row.timestamp, zone);
    if (normalized === undefined) {
      if (tally.unrecognized.length < 10) tally.unrecognized.push(row.timestamp);
      continue;
    }
    updates.push([keyOf(row), normalized]);
    tally.converted += 1;
  }
  return { updates, tally };
}

function report(table: string, tally: Tally): void {
  console.log(
    `${table}: ${tally.converted} converted, ${tally.canonical} already RFC3339, ` +
      `${tally.unrecognized.length} left alone`,
  );
  for (const sample of tally.unrecognized) console.log(`  left alone: ${JSON.stringify(sample)}`);
}

function searchIndexes(root: string): string[] {
  const characters = join(root, "characters");
  if (!existsSync(characters)) return [];
  return readdirSync(characters)
    .map((name) => join(characters, name, "history_search.db"))
    .filter((path) => existsSync(path));
}
