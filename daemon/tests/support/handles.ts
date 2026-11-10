import { readdirSync, readlinkSync, realpathSync } from "node:fs";

export function handlesUnder(dir: string): number {
  const root = realpathSync(dir);
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    let target: string;
    try {
      target = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue;
    }
    if (target === root || target.startsWith(`${root}/`)) count += 1;
  }
  return count;
}
