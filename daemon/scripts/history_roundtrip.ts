import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";

import { HistoryStore } from "../src/engine/history_store.ts";
import { normalizeMessage } from "../src/engine/message_store.ts";
import type { Message } from "../src/engine/types.ts";

const segmentsDir = process.argv[2];
const dbPath = process.argv[3] ?? "/tmp/history_roundtrip.db";

if (segmentsDir === undefined) {
  console.error("usage: bun run scripts/history_roundtrip.ts <segments-dir> [db-path]");
  process.exit(2);
}

function deepEqual(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join(",") !== kb.join(",")) return `${path}: keys [${ka}] vs [${kb}]`;
    for (const k of ka) {
      const left = (a as Record<string, unknown>)[k];
      const right = (b as Record<string, unknown>)[k];
      const d = deepEqual(left, right, `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(`${entry.parentPath}/${entry.name}`);
    }
  }
  return out.sort();
}

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
const db = new Database(dbPath, { create: true, readwrite: true });
db.exec("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;");
const store = new HistoryStore(db);

const files = jsonlFiles(segmentsDir);
const failures: string[] = [];
let rawBytes = 0;
let totalMessages = 0;
let totalAlternatives = 0;
let mismatches = 0;
let empty = 0;

files.forEach((file, idx) => {
  rawBytes += statSync(file).size;
  const expected: Message[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      expected.push(normalizeMessage(JSON.parse(line) as Message));
    } catch {
      continue;
    }
  }
  if (expected.length === 0) {
    empty++;
    return;
  }
  totalMessages += expected.length;
  for (const message of expected) totalAlternatives += message.alternatives?.length ?? 0;

  store.putSegment(
    "roundtrip",
    idx,
    {
      file: file.slice(segmentsDir.length + 1),
      message_count: expected.length,
      compacted_at: expected[0]!.timestamp,
    },
    expected,
  );

  const actual = store.readSegment("roundtrip", idx);
  if (actual.length !== expected.length) {
    mismatches++;
    failures.push(`${file}: ${expected.length} in, ${actual.length} out`);
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    const diff = deepEqual(expected[i], actual[i], `msg[${i}]`);
    if (diff !== null) {
      mismatches++;
      if (failures.length < 5) failures.push(`${file} ${diff}`);
      break;
    }
  }
});

db.exec("PRAGMA incremental_vacuum;");
db.close();

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const dbBytes = statSync(dbPath).size;
console.log(`files             : ${files.length} (${empty} empty)`);
console.log(`messages          : ${totalMessages} (+${totalAlternatives} alternatives)`);
console.log(`segments verified : ${files.length - empty - mismatches}/${files.length - empty}`);
console.log(`mismatches        : ${mismatches}`);
for (const failure of failures) console.log(`   ${failure}`);
console.log(`jsonl raw         : ${mb(rawBytes)}`);
console.log(`store             : ${mb(dbBytes)}`);
console.log(`shrink            : ${(rawBytes / dbBytes).toFixed(1)}x`);

process.exit(mismatches === 0 ? 0 : 1);
