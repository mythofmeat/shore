import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const JOURNAL = "/tmp/shore-rerecord.jsonl";
const ROOT = join(import.meta.dir, "..");

interface Entry {
  capture: string;
  pointer: (string | number)[];
  value: unknown;
}

function expand(node: unknown, table: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((v) => expand(v, table));
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const ref = record["$ref"];
  if (typeof ref === "string" && Object.keys(record).length === 1) {
    return expand(table[ref], table);
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v, table)]));
}

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sort(x)]),
    );
  };
  return JSON.stringify(sort(value));
}

function setAt(root: unknown, pointer: (string | number)[], value: unknown): boolean {
  let node = root;
  for (const key of pointer.slice(0, -1)) {
    if (node === null || typeof node !== "object") return false;
    node = (node as Record<string | number, unknown>)[key];
  }
  const last = pointer[pointer.length - 1];
  if (node === null || typeof node !== "object" || last === undefined) return false;
  (node as Record<string | number, unknown>)[last] = value;
  return true;
}

const args = new Set(process.argv.slice(2));
const check = args.has("--check");

rmSync(JOURNAL, { force: true });

const run = Bun.spawnSync(["bun", "test"], {
  cwd: ROOT,
  env: { ...process.env, SHORE_RERECORD: JOURNAL },
  stdout: "pipe",
  stderr: "pipe",
});

if (!existsSync(JOURNAL)) {
  console.error("no capture reported a value; is any test wired to recordedValue()?");
  console.error(new TextDecoder().decode(run.stderr).split("\n").slice(-8).join("\n"));
  process.exit(1);
}

const entries = readFileSync(JOURNAL, "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as Entry);

const byCapture = new Map<string, Entry[]>();
for (const entry of entries) {
  const list = byCapture.get(entry.capture) ?? [];
  list.push(entry);
  byCapture.set(entry.capture, list);
}

let differed = 0;
let written = 0;

for (const [capture, list] of byCapture) {
  const path = join(ROOT, capture);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const table = (raw["$shared"] ?? {}) as Record<string, unknown>;
  const doc = Object.fromEntries(
    Object.entries(raw)
      .filter(([k]) => k !== "$shared")
      .map(([k, v]) => [k, expand(v, table)]),
  );

  const before = canonical(doc);
  for (const entry of list) {
    if (!setAt(doc, entry.pointer, entry.value)) {
      console.error(`${capture}: no such path ${entry.pointer.join(".")}`);
      process.exit(1);
    }
  }
  const after = canonical(doc);

  if (before === after) {
    console.log(`${capture}: ${list.length} values re-derived, unchanged`);
    continue;
  }

  differed += 1;
  console.log(`${capture}: ${list.length} values re-derived, CHANGED`);
  if (check) continue;

  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  written += 1;
}

rmSync(JOURNAL, { force: true });

if (check && differed > 0) {
  console.error(`\n${differed} capture(s) no longer match what shore produces`);
  process.exit(1);
}
console.log(`\n${byCapture.size} capture(s) checked, ${differed} changed, ${written} rewritten`);
