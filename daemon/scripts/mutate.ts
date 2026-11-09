import * as ts from "typescript/unstable/ast";
import { closeSync, cpSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, setPriority, tmpdir } from "node:os";
import { join } from "node:path";

import { parseInventorySources } from "./capability_inventory.ts";
import { DAEMON_EQUIVALENTS, DAEMON_FLOORS } from "./mutation_guards.ts";

const ROOT = join(import.meta.dir, "..");
const COPIED = ["src", "tests"];
const LINKED = ["node_modules", "package.json", "bunfig.toml", "tsconfig.json", "prompts", "vendor", "dist", "scripts"];
const UNMUTATED = [/^src\/protocol\//, /^src\/testing\//, /\.d\.ts$/, /\.generated\./];
const MIN_TIMEOUT_MS = 60_000;
const TIMEOUT_FACTOR = 5;
const TEST_TIMEOUT = "--timeout=20000";
const MEMORY_CAP_BYTES = 2 * 1024 ** 3;
const capped = Bun.spawnSync(["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=64M", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const cap = capped ? ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${String(MEMORY_CAP_BYTES)}`, "-p", "MemorySwapMax=0"] : [];
const running = new Set<number>();
const scratch = new Set<string>();
const LOGGING_CALL = /^(?:shoreLog|console|(?:[\w$#]+\??\.)*log)\??\.(?:debug|info|warn|error|trace|log)(?:\?\.)?\(/;

export interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly lastLine: number;
  readonly scopeLines: readonly [number, number] | undefined;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

type Outcome = "killed" | "survived" | "timeout" | "uncovered";

interface Scope {
  readonly name: string;
  readonly owner: string | undefined;
  readonly lines: readonly [number, number] | undefined;
}

const BINARY: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsToken, "=="],
  [ts.SyntaxKind.LessThanToken, "<="],
  [ts.SyntaxKind.LessThanEqualsToken, "<"],
  [ts.SyntaxKind.GreaterThanToken, ">="],
  [ts.SyntaxKind.GreaterThanEqualsToken, ">"],
  [ts.SyntaxKind.AmpersandAmpersandToken, "||"],
  [ts.SyntaxKind.BarBarToken, "&&"],
  [ts.SyntaxKind.PlusToken, "-"],
  [ts.SyntaxKind.MinusToken, "+"],
  [ts.SyntaxKind.AsteriskToken, "/"],
  [ts.SyntaxKind.SlashToken, "*"],
]);

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function compact(text: string, max = 60): string {
  const flattened = flat(text).trim();
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function skipped(n: ts.Node): boolean {
  if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isHeritageClause(n) || ts.isTypeParameterDeclaration(n)) return true;
  if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isModuleDeclaration(n)) return true;
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)) && n.body === undefined) return true;
  return false;
}

function scopeOf(n: ts.Node, outer: Scope, source: ts.SourceFile, starts: readonly number[]): Scope {
  const lines = (): readonly [number, number] => [lineAt(starts, n.getStart(source)), lineAt(starts, n.end)];
  const member = (name: string): string => (outer.owner === undefined ? name : `${outer.owner}.${name}`);
  if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return { ...outer, owner: n.name?.text ?? outer.owner };
  if (ts.isFunctionDeclaration(n)) return { name: n.name?.text ?? outer.name, owner: outer.owner, lines: lines() };
  if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isPropertyDeclaration(n)) return { name: member(n.name.getText(source)), owner: outer.owner, lines: lines() };
  if (ts.isConstructorDeclaration(n)) return { name: member("constructor"), owner: outer.owner, lines: lines() };
  if (ts.isClassStaticBlockDeclaration(n)) return { name: member("static"), owner: outer.owner, lines: lines() };
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    const { parent } = n;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return { name: parent.name.text, owner: outer.owner, lines: lines() };
    if (ts.isPropertyAssignment(parent)) return { name: parent.name.getText(source), owner: outer.owner, lines: lines() };
    return { ...outer, lines: lines() };
  }
  return outer;
}

export function mutantsOf(file: string, text: string, source: ts.SourceFile): Mutant[] {
  const starts = lineStarts(text);
  const raw: { start: number; end: number; replacement: string; scope: Scope }[] = [];
  const visit = (n: ts.Node, scope: Scope): void => {
    if (skipped(n)) return;
    if (ts.isCallExpression(n) && LOGGING_CALL.test(n.getText(source))) return;
    const add = (start: number, end: number, replacement: string): void => {
      raw.push({ start, end, replacement, scope });
    };
    if (ts.isBinaryExpression(n)) {
      const swapped = BINARY.get(n.operatorToken.kind);
      if (swapped !== undefined) add(n.operatorToken.getStart(source), n.operatorToken.end, swapped);
    }
    if ((ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) && n.expression.kind !== ts.SyntaxKind.TrueKeyword) {
      add(n.expression.getStart(source), n.expression.end, `!(${n.expression.getText(source)})`);
    }
    if (ts.isConditionalExpression(n)) add(n.condition.getStart(source), n.condition.end, `!(${n.condition.getText(source)})`);
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) add(n.getStart(source), n.end, n.operand.getText(source));
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) add(n.getStart(source), n.end, n.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true");
    if (ts.isNumericLiteral(n)) {
      const value = Number(n.text);
      if (Number.isFinite(value)) add(n.getStart(source), n.end, String(value + 1));
    }
    const deletable = (ts.isExpressionStatement(n) && !LOGGING_CALL.test(n.expression.getText(source))) || ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n);
    if (deletable) add(n.getStart(source), n.end, "{}");
    const inner = scopeOf(n, scope, source, starts);
    n.forEachChild((child) => {
      visit(child, inner);
    });
  };
  const top: Scope = { name: "<module>", owner: undefined, lines: undefined };
  source.forEachChild((child) => {
    visit(child, top);
  });
  const seen = new Map<string, number>();
  return raw
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((m) => {
      const lineStart = text.lastIndexOf("\n", m.start - 1) + 1;
      const newline = text.indexOf("\n", m.end);
      const before = flat(text.slice(lineStart, m.start)).trimStart();
      const after = flat(text.slice(m.end, newline === -1 ? text.length : newline)).trimEnd();
      const shown = `${before.length > 32 ? `…${before.slice(-31)}` : before}「${compact(text.slice(m.start, m.end), 40)} → ${compact(m.replacement, 40)}」${after.length > 32 ? `${after.slice(0, 31)}…` : after}`;
      const key = `${file}:${m.scope.name}: ${shown}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return {
        id: n > 1 ? `${key} #${String(n)}` : key,
        file,
        line: lineAt(starts, m.start),
        lastLine: lineAt(starts, m.end),
        scopeLines: m.scope.lines,
        start: m.start,
        end: m.end,
        replacement: m.replacement,
      };
    });
}

export function mutatedFiles(): string[] {
  return [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync(ROOT)].filter((file) => !UNMUTATED.some((re) => re.test(file))).sort();
}

export async function allMutants(files: readonly string[]): Promise<Map<string, Mutant[]>> {
  const result = new Map<string, Mutant[]>();
  for (const extension of ["ts", "tsx"] as const) {
    const mine = files.filter((file) => file.endsWith(`.${extension}`));
    if (mine.length === 0) continue;
    const texts = mine.map((file) => readFileSync(join(ROOT, file), "utf8"));
    const sources = await parseInventorySources(texts, extension);
    mine.forEach((file, i) => {
      const source = sources[i];
      const text = texts[i];
      if (source === undefined || text === undefined) throw new Error(`could not parse ${file}`);
      result.set(file, mutantsOf(file, text, source));
    });
  }
  return result;
}

export function changedLines(rev: string): Map<string, Set<number>> {
  const diff = Bun.spawnSync(["git", "diff", "--no-color", "--no-ext-diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/", "-U0", "-M", rev, "--", "src"], { cwd: ROOT, stderr: "pipe" });
  if (!diff.success) throw new Error(`git diff ${rev} failed: ${diff.stderr.toString().trim()}`);
  const changed = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const line of diff.stdout.toString().split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      lines = undefined;
      if (path.startsWith("b/")) {
        lines = changed.get(path.slice(2)) ?? new Set();
        changed.set(path.slice(2), lines);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || lines === undefined) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = 0; i < count; i++) lines.add(first + i);
  }
  return changed;
}

export function inDiff(mutant: Mutant, changed: ReadonlyMap<string, ReadonlySet<number>>): boolean {
  const lines = changed.get(mutant.file);
  if (lines === undefined) return false;
  for (let line = mutant.line; line <= mutant.lastLine; line++) if (lines.has(line)) return true;
  return false;
}

export interface Coverage {
  readonly tests: readonly string[];
  readonly ms: readonly number[];
  readonly hits: ReadonlyMap<string, ReadonlyMap<number, readonly number[]>>;
  readonly executable: ReadonlyMap<string, ReadonlySet<number>>;
}

export function parseLcov(text: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = files.get(line.slice(3)) ?? new Map();
      files.set(line.slice(3), current);
    } else if (line.startsWith("DA:") && current !== undefined) {
      const [at, count] = line.slice(3).split(",");
      const lineNumber = Number(at);
      current.set(lineNumber, Math.max(current.get(lineNumber) ?? 0, Number(count)));
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return files;
}

export function testsFor(mutant: Mutant, coverage: Coverage): number[] | undefined {
  const hits = coverage.hits.get(mutant.file);
  const executable = coverage.executable.get(mutant.file);
  if (hits === undefined || executable === undefined) return undefined;
  const covering = (from: number, to: number): number[] => {
    const found = new Set<number>();
    for (let line = from; line <= to; line++) for (const test of hits.get(line) ?? []) found.add(test);
    return [...found].sort((a, b) => a - b);
  };
  for (let line = mutant.line; line <= mutant.lastLine; line++) {
    if (executable.has(line)) {
      const found = covering(mutant.line, mutant.lastLine);
      return found.length > 0 ? found : undefined;
    }
  }
  const [from, to] = mutant.scopeLines ?? [1, Number.MAX_SAFE_INTEGER];
  const found = covering(from, Math.min(to, Math.max(0, ...hits.keys())));
  return found.length > 0 ? found : undefined;
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "shore-mutate-"));
  scratch.add(dir);
  for (const name of COPIED) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  for (const name of LINKED) symlinkSync(join(ROOT, name), join(dir, name));
  return dir;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    running.delete(pid);
  }
}

async function bunTest(dir: string, args: readonly string[], timeoutMs: number, log?: string): Promise<{ code: number | undefined; ms: number }> {
  const started = performance.now();
  const fd = log === undefined ? undefined : openSync(log, "w");
  const proc = Bun.spawn(["setsid", ...cap, "bun", "test", ...args], { cwd: dir, stdout: fd ?? "ignore", stderr: fd ?? "ignore" });
  running.add(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(proc.pid);
  }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  if (fd !== undefined) closeSync(fd);
  killGroup(proc.pid);
  running.delete(proc.pid);
  return { code: timedOut ? undefined : code, ms: performance.now() - started };
}

function cleanUp(): void {
  for (const pid of running) killGroup(pid);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

async function pool<T, R>(items: readonly T[], workers: number, label: string, work: (dir: string, item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  let done = 0;
  const dirs = Array.from({ length: Math.min(workers, items.length) }, workspace);
  try {
    await Promise.all(
      dirs.map(async (dir) => {
        for (;;) {
          const index = next++;
          const item = items[index];
          if (item === undefined) return;
          results[index] = await work(dir, item);
          done++;
          if (done % 25 === 0 || done === items.length) process.stderr.write(`  ${label} ${String(done)}/${String(items.length)}\n`);
        }
      }),
    );
  } finally {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
      scratch.delete(dir);
    }
  }
  return results;
}

function failures(log: string): string {
  let lines: string[];
  try {
    lines = readFileSync(log, "utf8").split("\n");
  } catch {
    return "";
  }
  const shown = new Set<number>();
  lines.forEach((line, i) => {
    if (!line.startsWith("(fail)")) return;
    for (let j = Math.max(0, i - 30); j <= i; j++) shown.add(j);
  });
  if (shown.size === 0) for (let j = Math.max(0, lines.length - 40); j < lines.length; j++) shown.add(j);
  return [...shown].sort((a, b) => a - b).map((j) => `    | ${lines[j] ?? ""}`).join("\n");
}

async function collectCoverage(files: ReadonlySet<string>, workers: number): Promise<{ coverage: Coverage; problems: string[] }> {
  const tests = [...new Bun.Glob("*.test.{ts,tsx}").scanSync(join(ROOT, "tests"))].sort();
  const logs = mkdtempSync(join(tmpdir(), "shore-mutate-logs-"));
  const runs = await pool(tests, workers, "coverage", async (dir, test) => {
    const out = join(dir, "coverage-out");
    rmSync(out, { recursive: true, force: true });
    const log = join(logs, `${test}.log`);
    const run = await bunTest(dir, [TEST_TIMEOUT, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${out}`, `./tests/${test}`], MIN_TIMEOUT_MS * 10, log);
    let lcov = "";
    try {
      lcov = readFileSync(join(out, "lcov.info"), "utf8");
    } catch {
      lcov = "";
    }
    rmSync(out, { recursive: true, force: true });
    return { test, run, lcov: parseLcov(lcov), log };
  });
  const problems: string[] = [];
  const hits = new Map<string, Map<number, number[]>>();
  const executable = new Map<string, Set<number>>();
  runs.forEach(({ test, run, lcov, log }, index) => {
    if (run.code !== 0) problems.push(`tests/${test} fails before any mutation (${run.code === undefined ? "timed out" : `exit ${String(run.code)}`}); its output is in ${log}\n${failures(log)}`);
    else rmSync(log, { force: true });
    for (const [file, lines] of lcov) {
      if (!files.has(file)) continue;
      const fileHits = hits.get(file) ?? new Map<number, number[]>();
      hits.set(file, fileHits);
      const fileLines = executable.get(file) ?? new Set<number>();
      executable.set(file, fileLines);
      for (const [line, count] of lines) {
        fileLines.add(line);
        if (count > 0) fileHits.set(line, [...(fileHits.get(line) ?? []), index]);
      }
    }
  });
  if (problems.length === 0) rmSync(logs, { recursive: true, force: true });
  return { coverage: { tests, ms: runs.map((r) => r.run.ms), hits, executable }, problems };
}

interface Result {
  readonly mutant: Mutant;
  readonly outcome: Outcome;
}

function stem(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.(test\.)?tsx?$/u, "");
}

export function likeliestFirst(mutant: Mutant, tests: readonly number[], coverage: Coverage): number[] {
  const own = stem(mutant.file);
  const rank = (t: number): number => (stem(coverage.tests[t] ?? "") === own ? 0 : 1);
  return [...tests].sort((a, b) => rank(a) - rank(b) || (coverage.ms[a] ?? 0) - (coverage.ms[b] ?? 0) || a - b);
}

async function runMutants(mutants: readonly Mutant[], coverage: Coverage, workers: number): Promise<Result[]> {
  const planned = mutants.map((mutant) => {
    const tests = testsFor(mutant, coverage);
    return { mutant, tests: tests === undefined ? undefined : likeliestFirst(mutant, tests, coverage) };
  });
  const covered = planned.filter((p) => p.tests !== undefined);
  const cost = (tests: readonly number[] | undefined): number => (tests ?? []).reduce((sum, t) => sum + (coverage.ms[t] ?? 0), 0);
  covered.sort((a, b) => cost(b.tests) - cost(a.tests));
  const files = covered.reduce((sum, p) => sum + (p.tests?.length ?? 0), 0);
  console.error(`${String(mutants.length)} mutants, ${String(mutants.length - covered.length)} on lines no test runs, ${covered.length === 0 ? "0" : (files / covered.length).toFixed(1)} test files each on average, ${String(workers)} workers`);
  const ran = await pool(covered, workers, "mutants", async (dir, { mutant, tests }) => {
    const path = join(dir, mutant.file);
    const pristine = readFileSync(path, "utf8");
    writeFileSync(path, pristine.slice(0, mutant.start) + mutant.replacement + pristine.slice(mutant.end));
    try {
      const chosen = tests ?? [];
      const timeout = Math.max(MIN_TIMEOUT_MS, Math.ceil(cost(chosen) * TIMEOUT_FACTOR));
      const run = await bunTest(dir, [TEST_TIMEOUT, "--bail", ...chosen.map((t) => `./tests/${coverage.tests[t] ?? ""}`)], timeout);
      const outcome: Outcome = run.code === undefined ? "timeout" : run.code === 0 ? "survived" : "killed";
      return { mutant, outcome };
    } finally {
      writeFileSync(path, pristine);
    }
  });
  const uncovered = planned.filter((p) => p.tests === undefined).map(({ mutant }): Result => ({ mutant, outcome: "uncovered" }));
  const order = new Map(mutants.map((m, i) => [m, i]));
  return [...ran, ...uncovered].sort((a, b) => (order.get(a.mutant) ?? 0) - (order.get(b.mutant) ?? 0));
}

export function floorFor(file: string): number {
  return DAEMON_FLOORS[file] ?? 1;
}

export function tableProblems(mutants: ReadonlyMap<string, readonly Mutant[]>): string[] {
  const ids = new Set<string>();
  for (const list of mutants.values()) for (const m of list) ids.add(m.id);
  const problems: string[] = [];
  for (const [file, floor] of Object.entries(DAEMON_FLOORS)) {
    if ((mutants.get(file)?.length ?? 0) === 0) problems.push(`floor for ${file}, which has no mutants`);
    if (!(floor >= 0 && floor < 1)) problems.push(`floor for ${file} is ${String(floor)}; a file with no floor must catch every mutant, so a floor must be below 1`);
  }
  const listed = new Set<string>();
  for (const id of DAEMON_EQUIVALENTS) {
    if (listed.has(id)) problems.push(`equivalent mutant listed twice: ${id}`);
    listed.add(id);
    if (!ids.has(id)) problems.push(`equivalent mutant matches no mutant: ${id}`);
  }
  return problems;
}

function shardOf(files: readonly string[], mutants: ReadonlyMap<string, readonly Mutant[]>, index: number, count: number): string[] {
  const loads = Array.from({ length: count }, () => 0);
  const mine: string[] = [];
  for (const file of [...files].sort((a, b) => (mutants.get(b)?.length ?? 0) - (mutants.get(a)?.length ?? 0) || a.localeCompare(b))) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + (mutants.get(file)?.length ?? 0);
    if (lightest === index - 1) mine.push(file);
  }
  return mine.sort();
}

function describe(result: Result): string {
  return `${result.outcome === "uncovered" ? "no test runs" : result.outcome}: ${result.mutant.file}:${String(result.mutant.line)}  ${result.mutant.id}`;
}

async function main(args: readonly string[]): Promise<number> {
  setPriority(19);
  if (args.includes("--client")) {
    const { main: client } = await import("./mutate_client.ts");
    return client(args.filter((a) => a !== "--client"));
  }
  const listOnly = args.includes("--list");
  const filters = args.filter((a) => !a.startsWith("--"));
  const diffArg = args.find((a) => a.startsWith("--diff="));
  const shardArg = args.find((a) => a.startsWith("--shard="));
  const shard = shardArg === undefined ? undefined : /^--shard=(\d+)\/(\d+)$/.exec(shardArg);
  if (shard === null || (shard !== undefined && (Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2])))) {
    console.error("--shard takes i/n with 1 <= i <= n, such as --shard=2/4");
    return 2;
  }
  const files = mutatedFiles();
  const mutants = await allMutants(files);
  const problems = tableProblems(mutants);
  const equivalent = new Set(DAEMON_EQUIVALENTS);

  if (listOnly) {
    for (const file of files) {
      const mine = mutants.get(file) ?? [];
      if (mine.length === 0 || (filters.length > 0 && !filters.some((f) => file.includes(f)))) continue;
      console.log(`${String(mine.length).padStart(5)}  ${file}`);
      if (filters.length > 0) for (const m of mine) console.log(`         ${String(m.line).padStart(5)}  ${m.id}`);
    }
    for (const p of problems) console.error(`problem: ${p}`);
    return problems.length > 0 ? 1 : 0;
  }

  const requested = Number(args.find((a) => a.startsWith("--workers="))?.slice("--workers=".length));
  const workers = Number.isInteger(requested) && requested > 0
    ? requested
    : Math.max(1, Math.min(Math.floor(availableParallelism() / 4), capped ? Math.floor(freemem() / (MEMORY_CAP_BYTES * 1.25)) : Infinity));
  if (!capped) console.error("systemd-run --user is unavailable, so test runs have no memory cap");

  if (diffArg !== undefined) {
    const rev = diffArg.slice("--diff=".length);
    const changed = changedLines(rev);
    const chosen = [...mutants.values()].flat().filter((m) => inDiff(m, changed));
    console.log(`${String(chosen.length)} mutants on lines changed since ${rev}`);
    if (chosen.length === 0) {
      for (const p of problems) console.log(`problem: ${p}`);
      return problems.length > 0 ? 1 : 0;
    }
    const { coverage, problems: baseline } = await collectCoverage(new Set(chosen.map((m) => m.file)), workers);
    problems.push(...baseline);
    if (baseline.length > 0) {
      for (const p of problems) console.log(`problem: ${p}`);
      return 1;
    }
    const results = await runMutants(chosen, coverage, workers);
    let missed = 0;
    for (const r of results) {
      const caught = r.outcome === "killed" || r.outcome === "timeout";
      if (equivalent.has(r.mutant.id)) {
        if (caught) problems.push(`listed as equivalent, but a test catches it: ${r.mutant.id}`);
        continue;
      }
      if (caught) continue;
      missed++;
      console.log(describe(r));
    }
    console.log(`${String(results.length - missed)}/${String(results.length)} mutants on changed lines caught`);
    if (missed > 0) console.log("Every mutant on a changed line must fail a test. Add a test for each one above, or, when no input can tell a mutant apart from the original, add its id to DAEMON_EQUIVALENTS in scripts/mutation_guards.ts and say why in the pull request.");
    for (const p of problems) console.log(`problem: ${p}`);
    return missed > 0 || problems.length > 0 ? 1 : 0;
  }

  const filtered = files.filter((file) => (mutants.get(file)?.length ?? 0) > 0 && (filters.length === 0 || filters.some((f) => file.includes(f))));
  const targets = shard === undefined ? filtered : shardOf(filtered, mutants, Number(shard[1]), Number(shard[2]));
  const chosen = targets.flatMap((file) => mutants.get(file) ?? []);
  const { coverage, problems: baseline } = await collectCoverage(new Set(targets), workers);
  problems.push(...baseline);
  if (baseline.length > 0 || args.includes("--baseline")) {
    for (const p of problems) console.log(`problem: ${p}`);
    return problems.length > 0 ? 1 : 0;
  }
  const results = await runMutants(chosen, coverage, workers);
  const showSurvivors = args.includes("--survivors");
  let below = 0;
  let caughtAll = 0;
  let countedAll = 0;
  for (const file of targets) {
    const mine = results.filter((r) => r.mutant.file === file);
    const counted = mine.filter((r) => !equivalent.has(r.mutant.id));
    for (const r of mine) if (equivalent.has(r.mutant.id) && r.outcome !== "survived" && r.outcome !== "uncovered") problems.push(`listed as equivalent, but a test catches it: ${r.mutant.id}`);
    const caught = counted.filter((r) => r.outcome === "killed" || r.outcome === "timeout").length;
    caughtAll += caught;
    countedAll += counted.length;
    const rate = counted.length === 0 ? 1 : caught / counted.length;
    const floor = floorFor(file);
    const failing = rate < floor;
    if (failing) below++;
    const uncovered = counted.filter((r) => r.outcome === "uncovered").length;
    const timedOut = counted.filter((r) => r.outcome === "timeout").length;
    const notes = [uncovered > 0 ? `${String(uncovered)} on lines no test runs` : "", timedOut > 0 ? `${String(timedOut)} timed out` : ""].filter((n) => n !== "").join(", ");
    console.log(`${failing ? "BELOW" : "ok   "} ${(rate * 100).toFixed(1).padStart(5)}% (floor ${String(Math.round(floor * 100))}%) ${String(caught)}/${String(counted.length)}${notes === "" ? "" : ` (${notes})`}  ${file}`);
    if (!showSurvivors && !failing) continue;
    for (const r of counted) if (r.outcome === "survived" || r.outcome === "uncovered") console.log(`    ${describe(r)}`);
  }
  console.log(`${String(caughtAll)}/${String(countedAll)} mutants caught`);
  for (const p of problems) console.log(`problem: ${p}`);
  return below > 0 || problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
