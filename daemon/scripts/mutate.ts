import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = import.meta.dir;

const passes = readdirSync(SCRIPTS)
  .filter((n) => n.startsWith("mutate_") && n.endsWith(".py"))
  .map((n) => n.slice("mutate_".length, -".py".length))
  .sort();

const requested = process.argv.slice(2);
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
  console.error(`\n── ${name} (${i + 1}/${selected.length}) ─────────────────────────────`);
  const result = spawnSync("python3", [join(SCRIPTS, `mutate_${name}.py`)], {
    stdio: "inherit",
    cwd: join(SCRIPTS, ".."),
  });
  outcomes.push({ pass: name, code: result.status ?? 1 });
}

const failed = outcomes.filter((o) => o.code !== 0);
console.error(`\n${outcomes.length - failed.length}/${outcomes.length} passes clean`);
for (const o of failed) console.error(`  needs attention: ${o.pass}`);

process.exit(failed.length > 0 ? 1 : 0);
