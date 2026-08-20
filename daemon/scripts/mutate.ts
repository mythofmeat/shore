import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = import.meta.dir;

const passes = readdirSync(SCRIPTS)
  .filter((n) => n.startsWith("mutate_") && n.endsWith(".py"))
  .map((n) => n.slice("mutate_".length, -".py".length))
  .sort();

const argv = process.argv.slice(2);
const staleOnly = argv.includes("--stale");
const requested = argv.filter((a) => a !== "--stale");
const unknown = requested.filter((n) => !passes.includes(n));
if (unknown.length > 0) {
  console.error(`unknown pass(es): ${unknown.join(", ")}`);
  console.error(`available: ${passes.join(", ")}`);
  process.exit(2);
}

const selected = requested.length > 0 ? requested : passes;

interface Outcome {
  pass: string;
  code: number;
}

const outcomes: Outcome[] = [];

for (const [i, name] of selected.entries()) {
  if (!staleOnly) {
    console.error(`\n── ${name} (${i + 1}/${selected.length}) ─────────────────────────────`);
  }
  const args = [join(SCRIPTS, `mutate_${name}.py`), ...(staleOnly ? ["--stale"] : [])];
  const result = spawnSync("python3", args, {
    stdio: staleOnly ? "pipe" : "inherit",
    cwd: join(SCRIPTS, ".."),
    encoding: "utf8",
  });
  const code = result.status ?? 1;
  if (staleOnly && code !== 0) {
    console.error(`\n── ${name}\n${(result.stdout ?? "") + (result.stderr ?? "")}`.trimEnd());
  }
  outcomes.push({ pass: name, code });
}

const failed = outcomes.filter((o) => o.code !== 0);
const clean = staleOnly ? "passes free of stale mutants" : "passes clean";
console.error(`\n${outcomes.length - failed.length}/${outcomes.length} ${clean}`);
for (const o of failed) console.error(`  needs attention: ${o.pass}`);

process.exit(failed.length > 0 ? 1 : 0);
