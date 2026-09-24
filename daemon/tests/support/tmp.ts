import { afterAll } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_PREFIX = "shore-test-";

const runRoot = join(tmpdir(), `${ROOT_PREFIX}${process.pid}`);

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sweepAbandonedRoots(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(ROOT_PREFIX)) continue;
    const pid = Number(entry.slice(ROOT_PREFIX.length));
    if (!Number.isInteger(pid) || pid === process.pid || pidIsRunning(pid)) continue;
    rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
}

sweepAbandonedRoots();

afterAll(() => {
  rmSync(runRoot, { recursive: true, force: true });
});

export function testRunRoot(): string {
  mkdirSync(runRoot, { recursive: true });
  return runRoot;
}

export function testTmp(prefix: string): string {
  return join(testRunRoot(), prefix);
}
