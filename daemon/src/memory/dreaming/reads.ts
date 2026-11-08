import { isAbsolute, relative, resolve, sep } from "node:path";

import { deleteCharacterState, readCharacterState, writeCharacterState } from "../../storage/store.ts";
import { toolMediaOf } from "../../tools/media.ts";

const READS_STATE = "workspace_reads.json";

const READ_HEADER = /^(.+): lines (\d+)–\d+$/;

export function readWorkspacePath(value: unknown, workspaceDir: string): string | undefined {
  const text = typeof value === "string" ? value : toolMediaOf(value)?.value;
  if (typeof text !== "string") return undefined;
  const match = READ_HEADER.exec(text.split("\n", 1)[0] ?? "");
  const path = match?.[1];
  if (path === undefined || match?.[2] !== "1") return undefined;
  const inside = relative(resolve(workspaceDir), resolve(path));
  return inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : inside;
}

export function workspaceReadCounts(characterDataDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readCharacterState(characterDataDir, READS_STATE) ?? "{}");
  } catch {
    return counts;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return counts;
  for (const [path, count] of Object.entries(parsed)) {
    if (typeof count === "number" && Number.isInteger(count) && count > 0) counts.set(path, count);
  }
  return counts;
}

function saveCounts(characterDataDir: string, counts: ReadonlyMap<string, number>): void {
  if (counts.size === 0) deleteCharacterState(characterDataDir, READS_STATE);
  else writeCharacterState(characterDataDir, READS_STATE, JSON.stringify(Object.fromEntries(counts)));
}

export function recordWorkspaceRead(characterDataDir: string, path: string): void {
  const counts = workspaceReadCounts(characterDataDir);
  counts.set(path, (counts.get(path) ?? 0) + 1);
  saveCounts(characterDataDir, counts);
}

export function forgetWorkspaceReads(characterDataDir: string, seen: ReadonlyMap<string, number>): void {
  const counts = workspaceReadCounts(characterDataDir);
  for (const [path, count] of seen) {
    const left = (counts.get(path) ?? 0) - count;
    if (left > 0) counts.set(path, left);
    else counts.delete(path);
  }
  saveCounts(characterDataDir, counts);
}

export function mostReadLines(counts: ReadonlyMap<string, number>, limit: number): string[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([path, count]) => `- \`${path}\`: read ${count === 1 ? "once" : `${String(count)} times`}`);
}
