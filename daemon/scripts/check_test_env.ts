import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const TESTS = join(ROOT, "tests");
const OWNERS = new Set(["support/env.ts", "fixture_env.ts"]);
const WRITE = /\bprocess\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:=(?!=)|\+=)|\bdelete\s+process\.env\b|Object\.assign\(\s*process\.env\b/;

const offenders: string[] = [];
for (const rel of new Glob("**/*.ts").scanSync(TESTS)) {
  if (OWNERS.has(rel)) continue;
  const lines = readFileSync(join(TESTS, rel), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (WRITE.test(line)) offenders.push(`${relative(ROOT, join(TESTS, rel))}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length > 0) {
  console.error(`Tests write process.env directly in ${offenders.length} place(s):\n`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error("\nUse setTestEnv/unsetTestEnv from tests/support/env.ts; the preload restores them after every test.");
  process.exit(1);
}
console.log("no direct process.env writes in tests");
