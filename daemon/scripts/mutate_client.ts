import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, setPriority, tmpdir } from "node:os";
import { join } from "node:path";

import { CLIENT_EQUIVALENTS, CLIENT_FLOORS } from "./mutation_guards.ts";

const CLIENT = join(import.meta.dir, "..", "..", "client");

export interface CargoMutant {
  readonly name: string;
  readonly file: string;
  readonly span: { readonly start: { readonly line: number; readonly column: number } };
}

interface CargoOutcome {
  readonly scenario: "Baseline" | { readonly Mutant: CargoMutant };
  readonly summary: string;
}

export function stableIds(mutants: readonly CargoMutant[]): Map<string, string> {
  const ordered = [...mutants].sort((a, b) => a.file.localeCompare(b.file) || a.span.start.line - b.span.start.line || a.span.start.column - b.span.start.column || a.name.localeCompare(b.name));
  const seen = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const m of ordered) {
    const key = m.name.replace(/^([^:]+):\d+:\d+: /u, "$1: ");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    ids.set(m.name, n > 1 ? `${key} #${String(n)}` : key);
  }
  return ids;
}

export function clientTableProblems(mutants: readonly CargoMutant[], ids: ReadonlyMap<string, string>): string[] {
  const files = new Set(mutants.map((m) => m.file));
  const known = new Set(ids.values());
  const problems: string[] = [];
  for (const [file, floor] of Object.entries(CLIENT_FLOORS)) {
    if (!files.has(file)) problems.push(`floor for ${file}, which has no mutants`);
    if (!(floor >= 0 && floor < 1)) problems.push(`floor for ${file} is ${String(floor)}; a file with no floor must catch every mutant, so a floor must be below 1`);
  }
  const listed = new Set<string>();
  for (const id of CLIENT_EQUIVALENTS) {
    if (listed.has(id)) problems.push(`equivalent mutant listed twice: ${id}`);
    listed.add(id);
    if (!known.has(id)) problems.push(`equivalent mutant matches no mutant: ${id}`);
  }
  return problems;
}

function listing(): CargoMutant[] | undefined {
  const run = Bun.spawnSync(["cargo", "mutants", "--list", "--json"], { cwd: CLIENT, stderr: "inherit" });
  if (!run.success) return undefined;
  return JSON.parse(run.stdout.toString()) as CargoMutant[];
}

export function shardFiles(mutants: readonly CargoMutant[], index: number, count: number): string[] {
  const sizes = new Map<string, number>();
  for (const m of mutants) sizes.set(m.file, (sizes.get(m.file) ?? 0) + 1);
  const loads = Array.from({ length: count }, () => 0);
  const mine: string[] = [];
  for (const [file, size] of [...sizes].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + size;
    if (lightest === index - 1) mine.push(file);
  }
  return mine.sort();
}

async function cargoMutants(extra: readonly string[], jobs: number): Promise<CargoOutcome[] | undefined> {
  const output = mkdtempSync(join(tmpdir(), "shore-mutate-client-"));
  try {
    const cargoTmp = join(output, "tmp");
    mkdirSync(cargoTmp);
    const idle = Bun.which("ionice") === null ? [] : ["ionice", "-c", "3"];
    const shared = process.env["CI"] === undefined ? ["--jobserver-tasks", String(Math.max(2, Math.floor(availableParallelism() / 4)))] : [];
    const cargo = Bun.spawn([...idle, "cargo", "mutants", "--no-shuffle", "-j", String(jobs), ...shared, "--output", output, ...extra], { cwd: CLIENT, env: { ...process.env, TMPDIR: cargoTmp }, stdout: "inherit", stderr: "inherit" });
    await cargo.exited;
    try {
      return (JSON.parse(readFileSync(join(output, "mutants.out", "outcomes.json"), "utf8")) as { outcomes: CargoOutcome[] }).outcomes;
    } catch {
      return undefined;
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

function caught(summary: string): boolean {
  return summary === "CaughtMutant" || summary === "Timeout";
}

export async function main(args: readonly string[]): Promise<number> {
  setPriority(19);
  const all = listing();
  if (all === undefined) return 1;
  const ids = stableIds(all);
  const problems = clientTableProblems(all, ids);
  const equivalent = new Set(CLIENT_EQUIVALENTS);
  const filters = args.filter((a) => !a.startsWith("--"));

  if (args.includes("--list")) {
    const byFile = new Map<string, CargoMutant[]>();
    for (const m of all) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    for (const [file, mine] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
      if (filters.length > 0 && !filters.some((f) => file.includes(f))) continue;
      console.log(`${String(mine.length).padStart(5)}  ${file}`);
      if (filters.length > 0) for (const m of mine) console.log(`         ${String(m.span.start.line).padStart(5)}  ${ids.get(m.name) ?? m.name}`);
    }
    for (const problem of problems) console.error(`problem: ${problem}`);
    return problems.length > 0 ? 1 : 0;
  }

  const requested = Number(args.find((a) => a.startsWith("--workers="))?.slice("--workers=".length));
  const jobs = Number.isInteger(requested) && requested > 0 ? requested : 2;
  const diffArg = args.find((a) => a.startsWith("--diff="));

  if (diffArg !== undefined) {
    const rev = diffArg.slice("--diff=".length);
    const diff = Bun.spawnSync(["git", "diff", "--no-color", "--no-ext-diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/", "-U0", rev, "--", "*.rs"], { cwd: CLIENT, stderr: "pipe" });
    if (!diff.success) {
      console.log(`problem: git diff ${rev} failed: ${diff.stderr.toString().trim()}`);
      return 1;
    }
    if (diff.stdout.length === 0) {
      console.log(`no Rust source changed since ${rev}`);
      for (const problem of problems) console.log(`problem: ${problem}`);
      return problems.length > 0 ? 1 : 0;
    }
    const dir = mkdtempSync(join(tmpdir(), "shore-mutate-diff-"));
    const patch = join(dir, "changes.diff");
    writeFileSync(patch, diff.stdout);
    let outcomes: CargoOutcome[] | undefined;
    try {
      outcomes = await cargoMutants(["--in-diff", patch], jobs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (outcomes === undefined) {
      console.log(`no mutants on Rust lines changed since ${rev}`);
      for (const problem of problems) console.log(`problem: ${problem}`);
      return problems.length > 0 ? 1 : 0;
    }
    if (outcomes.some((o) => o.scenario === "Baseline" && o.summary !== "Success")) problems.push("the client tests fail before any mutation");
    let missed = 0;
    let counted = 0;
    for (const o of outcomes) {
      if (o.scenario === "Baseline" || o.summary === "Unviable") continue;
      const mutant = o.scenario.Mutant;
      const id = ids.get(mutant.name) ?? mutant.name;
      if (equivalent.has(id)) {
        if (caught(o.summary)) problems.push(`listed as equivalent, but a test catches it: ${id}`);
        continue;
      }
      counted++;
      if (caught(o.summary)) continue;
      missed++;
      console.log(`missed: ${mutant.file}:${String(mutant.span.start.line)}  ${id}`);
    }
    console.log(`${String(counted - missed)}/${String(counted)} mutants on changed lines caught`);
    if (missed > 0) console.log("Every mutant on a changed line must fail a test. Add a test for each one above, or, when no input can tell a mutant apart from the original, add its id to CLIENT_EQUIVALENTS in daemon/scripts/mutation_guards.ts and say why in the pull request.");
    for (const problem of problems) console.log(`problem: ${problem}`);
    return missed > 0 || problems.length > 0 ? 1 : 0;
  }

  const shardArg = args.find((a) => a.startsWith("--shard="));
  const shard = shardArg === undefined ? undefined : /^--shard=(\d+)\/(\d+)$/u.exec(shardArg);
  if (shard === null || (shard !== undefined && (Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2])))) {
    console.error("--shard takes i/n with 1 <= i <= n, such as --shard=2/4");
    return 2;
  }
  const inScope = all.filter((m) => filters.length === 0 || filters.some((f) => m.file.includes(f)));
  const files = shard === undefined ? [...new Set(inScope.map((m) => m.file))].sort() : shardFiles(inScope, Number(shard[1]), Number(shard[2]));
  if (files.length === 0) {
    console.log("no files to mutate");
    return problems.length > 0 ? 1 : 0;
  }
  const outcomes = await cargoMutants(files.flatMap((file) => ["-f", file]), jobs);
  if (outcomes === undefined) {
    console.log("problem: cargo mutants wrote no outcomes");
    return 1;
  }
  if (outcomes.some((o) => o.scenario === "Baseline" && o.summary !== "Success")) problems.push("the client tests fail before any mutation");
  const byFile = new Map<string, { caught: number; missed: string[] }>();
  for (const file of files) byFile.set(file, { caught: 0, missed: [] });
  for (const o of outcomes) {
    if (o.scenario === "Baseline" || o.summary === "Unviable") continue;
    const mutant = o.scenario.Mutant;
    const id = ids.get(mutant.name) ?? mutant.name;
    if (equivalent.has(id)) {
      if (caught(o.summary)) problems.push(`listed as equivalent, but a test catches it: ${id}`);
      continue;
    }
    const entry = byFile.get(mutant.file) ?? { caught: 0, missed: [] };
    if (caught(o.summary)) entry.caught += 1;
    else entry.missed.push(`${mutant.file}:${String(mutant.span.start.line)}  ${id}`);
    byFile.set(mutant.file, entry);
  }
  let below = 0;
  let caughtAll = 0;
  let countedAll = 0;
  for (const [file, { caught: hits, missed }] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const total = hits + missed.length;
    caughtAll += hits;
    countedAll += total;
    const floor = CLIENT_FLOORS[file] ?? 1;
    const rate = total === 0 ? 1 : hits / total;
    const failing = rate < floor;
    if (failing) below++;
    console.log(`${failing ? "BELOW" : "ok   "} ${(rate * 100).toFixed(1).padStart(5)}% (floor ${String(Math.round(floor * 100))}%) ${String(hits)}/${String(total)}  ${file}`);
    if (args.includes("--survivors") || failing) for (const line of missed) console.log(`    missed: ${line}`);
  }
  console.log(`${String(caughtAll)}/${String(countedAll)} mutants caught`);
  for (const problem of problems) console.log(`problem: ${problem}`);
  return below > 0 || problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
