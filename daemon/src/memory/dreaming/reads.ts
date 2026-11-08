import { relative, sep } from "node:path";

import { deleteCharacterState, readCharacterState, writeCharacterState } from "../../storage/store.ts";
import { toolMediaOf } from "../../tools/media.ts";

const READS_STATE = "workspace_reads.json";

const READ_HEADER = /^(.+): lines \d+–\d+$/;

export function readWorkspacePath(value: unknown, workspaceDir: string): string | undefined {
  const text = typeof value === "string" ? value : toolMediaOf(value)?.value;
  if (typeof text !== "string") return undefined;
  const match = READ_HEADER.exec(text.split("\n", 1)[0] ?? "");
  const path = match?.[1];
  if (path === undefined) return undefined;
  const root = workspaceDir.endsWith(sep) ? workspaceDir : `${workspaceDir}${sep}`;
  return path.startsWith(root) ? relative(workspaceDir, path) : undefined;
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

export function recordWorkspaceRead(characterDataDir: string, path: string): void {
  const counts = workspaceReadCounts(characterDataDir);
  counts.set(path, (counts.get(path) ?? 0) + 1);
  writeCharacterState(characterDataDir, READS_STATE, JSON.stringify(Object.fromEntries(counts)));
}

export function clearWorkspaceReads(characterDataDir: string): void {
  deleteCharacterState(characterDataDir, READS_STATE);
}

export function mostReadLines(counts: ReadonlyMap<string, number>, limit: number): string[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([path, count]) => `- \`${path}\`: read ${count === 1 ? "once" : `${String(count)} times`}`);
}
