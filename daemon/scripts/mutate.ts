import * as ts from "typescript/unstable/ast";
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, tmpdir } from "node:os";
import { join } from "node:path";

import { parseInventorySources } from "./capability_inventory.ts";
import { GUARDS, type Guard } from "./mutation_guards.ts";

const ROOT = join(import.meta.dir, "..");
const COPIED = ["src", "tests"];
const LINKED = ["node_modules", "package.json", "bunfig.toml", "tsconfig.json", "prompts", "vendor", "dist", "scripts"];
const MIN_TIMEOUT_MS = 15_000;
const MEMORY_CAP_BYTES = 2 * 1024 ** 3;
const capped = Bun.spawnSync(["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=64M", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const cap = capped ? ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${String(MEMORY_CAP_BYTES)}`, "-p", "MemorySwapMax=0"] : [];
const TIMEOUT_FACTOR = 3;
const running = new Set<number>();
const scratch = new Set<string>();
const LOGGING_CALL = /^(shoreLog|console)\.\w+\(/;

interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly original: string;
  readonly replacement: string;
  readonly start: number;
  readonly end: number;
}

interface Target {
  readonly guard: Guard;
  readonly mutants: readonly Mutant[];
}

type Outcome = "killed" | "survived" | "timeout";

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

function compact(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function functionsNamed(source: ts.SourceFile, name: string): ts.Node[] {
  const dot = name.indexOf(".");
  const owner = dot === -1 ? undefined : name.slice(0, dot);
  const member = dot === -1 ? name : name.slice(dot + 1);
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (owner === undefined) {
      if (ts.isFunctionDeclaration(node) && node.body !== undefined && node.name?.text === member) found.push(node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === member && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found.push(node.initializer);
    } else if (ts.isClassDeclaration(node) && node.name?.text === owner) {
      for (const m of node.members) {
        if (ts.isConstructorDeclaration(m) && member === "constructor" && m.body !== undefined) found.push(m);
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body !== undefined && m.name.getText(source) === member) found.push(m);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

function mutantsIn(file: string, text: string, source: ts.SourceFile, fn: string, node: ts.Node): Mutant[] {
  const raw: { kind: string; start: number; end: number; replacement: string }[] = [];
  const statementSpan = (n: ts.Node): void => {
    raw.push({ kind: "delete", start: n.getStart(source), end: n.end, replacement: "{}" });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n)) {
      const swapped = BINARY.get(n.operatorToken.kind);
      if (swapped !== undefined) raw.push({ kind: "operator", start: n.operatorToken.getStart(source), end: n.operatorToken.end, replacement: swapped });
    }
    if ((ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) && n.expression.kind !== ts.SyntaxKind.TrueKeyword) {
      raw.push({ kind: "negate", start: n.expression.getStart(source), end: n.expression.end, replacement: `!(${n.expression.getText(source)})` });
    }
    if (ts.isConditionalExpression(n)) {
      raw.push({ kind: "negate", start: n.condition.getStart(source), end: n.condition.end, replacement: `!(${n.condition.getText(source)})` });
    }
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
      raw.push({ kind: "unnegate", start: n.getStart(source), end: n.end, replacement: n.operand.getText(source) });
    }
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) {
      raw.push({ kind: "boolean", start: n.getStart(source), end: n.end, replacement: n.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true" });
    }
    if (ts.isNumericLiteral(n)) {
      const value = Number(n.text);
      if (Number.isFinite(value)) raw.push({ kind: "number", start: n.getStart(source), end: n.end, replacement: String(value + 1) });
    }
    if (ts.isExpressionStatement(n) && !LOGGING_CALL.test(n.expression.getText(source))) statementSpan(n);
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n)) statementSpan(n);
    n.forEachChild(visit);
  };
  node.forEachChild(visit);
  const seen = new Map<string, number>();
  return raw
    .sort((a, b) => a.start - b.start)
    .map((m) => {
      const original = text.slice(m.start, m.end);
      const key = `${m.kind} \`${compact(original)}\``;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return {
        id: `${file}:${fn} ${key}${n > 1 ? `#${String(n)}` : ""}`,
        file,
        line: lineAt(text, m.start),
        original,
        replacement: m.replacement,
        start: m.start,
        end: m.end,
      };
    });
}

async function targetsFor(guards: readonly Guard[]): Promise<{ targets: Target[]; problems: string[] }> {
  const problems: string[] = [];
  const targets: Target[] = [];
  const parsed = new Map<string, { text: string; source: ts.SourceFile }>();
  for (const guard of guards) {
    for (const test of guard.tests) {
      if (!existsSync(join(ROOT, "tests", test))) problems.push(`no such test file: tests/${test}`);
    }
    const mutants: Mutant[] = [];
    for (const ref of guard.functions) {
      const colon = ref.lastIndexOf(":");
      const file = ref.slice(0, colon);
      const fn = ref.slice(colon + 1);
      let entry = parsed.get(file);
      if (entry === undefined) {
        const text = readFileSync(join(ROOT, file), "utf8");
        const [source] = await parseInventorySources([text], file.endsWith(".tsx") ? "tsx" : "ts");
        if (source === undefined) throw new Error(`could not parse ${file}`);
        entry = { text, source };
        parsed.set(file, entry);
      }
      const nodes = functionsNamed(entry.source, fn);
      if (nodes.length !== 1) {
        problems.push(`${ref}: ${nodes.length === 0 ? "no such function" : "more than one function by that name"}`);
        continue;
      }
      const [node] = nodes;
      if (node !== undefined) mutants.push(...mutantsIn(file, entry.text, entry.source, fn, node));
    }
    targets.push({ guard, mutants });
  }
  return { targets, problems };
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

async function runTests(dir: string, tests: readonly string[], timeoutMs: number, log?: string): Promise<{ outcome: Outcome; ms: number }> {
  const started = performance.now();
  const fd = log === undefined ? undefined : openSync(log, "w");
  const proc = Bun.spawn(["setsid", ...cap, "bun", "test", ...tests.map((t) => `./tests/${t}`)], {
    cwd: dir,
    stdout: fd ?? "ignore",
    stderr: fd ?? "ignore",
  });
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
  const ms = performance.now() - started;
  if (timedOut) return { outcome: "timeout", ms };
  return { outcome: code === 0 ? "survived" : "killed", ms };
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

interface Job {
  readonly target: Target;
  readonly mutant: Mutant | undefined;
}

interface Result {
  readonly job: Job;
  readonly outcome: Outcome;
  readonly ms: number;
}

async function runAll(jobs: readonly Job[], workers: number, timeouts: ReadonlyMap<Target, number>, logs?: string): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  let done = 0;
  const dirs = Array.from({ length: Math.min(workers, jobs.length) }, workspace);
  try {
    await Promise.all(
      dirs.map(async (dir) => {
        for (;;) {
          const job = jobs[next++];
          if (job === undefined) return;
          const { mutant } = job;
          const path = mutant === undefined ? undefined : join(dir, mutant.file);
          const pristine = path === undefined ? undefined : readFileSync(path, "utf8");
          if (mutant !== undefined && path !== undefined && pristine !== undefined) {
            writeFileSync(path, pristine.slice(0, mutant.start) + mutant.replacement + pristine.slice(mutant.end));
          }
          try {
            const log = logs === undefined ? undefined : join(logs, `${String(GUARDS.indexOf(job.target.guard))}.log`);
            const run = await runTests(dir, job.target.guard.tests, timeouts.get(job.target) ?? MIN_TIMEOUT_MS * 8, log);
            results.push({ job, ...run });
          } finally {
            if (path !== undefined && pristine !== undefined) writeFileSync(path, pristine);
          }
          done++;
          if (done % 25 === 0 || done === jobs.length) process.stderr.write(`  ${String(done)}/${String(jobs.length)}\n`);
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

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const filters = args.filter((a) => !a.startsWith("--"));
const chosen = GUARDS.filter((g) => filters.length === 0 || filters.some((f) => g.tests.some((t) => t.includes(f)) || g.functions.some((fn) => fn.includes(f))));
const { targets, problems } = await targetsFor(chosen);

if (listOnly) {
  for (const t of targets) {
    console.log(`${t.guard.tests.join(", ")}: ${String(t.mutants.length)} mutants`);
    for (const m of t.mutants) console.log(`  ${m.id}  ->  ${compact(m.replacement)}`);
  }
  for (const p of problems) console.error(`problem: ${p}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

const requested = Number(args.find((a) => a.startsWith("--workers="))?.slice("--workers=".length));
const workers = Number.isInteger(requested) && requested > 0
  ? requested
  : Math.max(1, Math.min(Math.floor(availableParallelism() / 2), capped ? Math.floor(freemem() / (MEMORY_CAP_BYTES * 1.25)) : Infinity));
if (!capped) console.error("systemd-run --user is unavailable, so test runs have no memory cap");
const logs = mkdtempSync(join(tmpdir(), "shore-mutate-logs-"));
const baseline = await runAll(targets.map((target) => ({ target, mutant: undefined })), workers, new Map(), logs);
const timeouts = new Map<Target, number>();
for (const r of baseline) {
  const log = join(logs, `${String(GUARDS.indexOf(r.job.target.guard))}.log`);
  if (r.outcome !== "survived") problems.push(`${r.job.target.guard.tests.join(", ")} fails before any mutation (${r.outcome}); its output is in ${log}`);
  else rmSync(log, { force: true });
  timeouts.set(r.job.target, Math.max(MIN_TIMEOUT_MS, Math.ceil(r.ms * TIMEOUT_FACTOR)));
}
if (args.includes("--baseline")) {
  for (const p of problems) console.log(`problem: ${p}`);
  if (problems.length === 0) rmSync(logs, { recursive: true, force: true });
  process.exit(problems.length > 0 ? 1 : 0);
}
const healthy = targets.filter((t) => baseline.some((r) => r.job.target === t && r.outcome === "survived"));
const jobs = healthy.flatMap((target) => target.mutants.map((mutant) => ({ target, mutant })));
console.error(`${String(jobs.length)} mutants across ${String(healthy.length)} guards, ${String(workers)} workers`);
const results = await runAll(jobs, workers, timeouts);

const showSurvivors = args.includes("--survivors");
let below = 0;
for (const target of healthy) {
  const mine = results.filter((r) => r.job.target === target);
  const killed = mine.filter((r) => r.outcome !== "survived").length;
  const rate = mine.length === 0 ? 1 : killed / mine.length;
  const floor = target.guard.floor;
  const failing = rate < floor;
  if (failing) below++;
  console.log(`${failing ? "BELOW" : "ok   "} ${(rate * 100).toFixed(1).padStart(5)}% (floor ${String(Math.round(floor * 100))}%) ${String(killed)}/${String(mine.length)}  ${target.guard.tests.join(", ")}`);
  if (!showSurvivors && !failing) continue;
  for (const r of mine) {
    const m = r.job.mutant;
    if (r.outcome !== "survived" || m === undefined) continue;
    console.log(`    survived: ${m.file}:${String(m.line)}  ${compact(m.original)}  ->  ${compact(m.replacement)}`);
  }
}
const killed = results.filter((r) => r.outcome !== "survived").length;
console.log(`${String(killed)}/${String(results.length)} mutants killed`);
for (const p of problems) console.log(`problem: ${p}`);
process.exit(below > 0 || problems.length > 0 ? 1 : 0);
