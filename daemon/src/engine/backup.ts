import { readDurable, writeDurable, listDurableFiles, deleteDurable } from "../storage/files.ts";
import { shoreLog } from "../log.ts";

import { basename, dirname, join } from "node:path";

export const BACKUP_THROTTLE_MS = 10_000;
export const MAX_BACKUPS = 8;
const BACKUP_DIR = "backups";

const lastBackupAt = new Map<string, number>();

export function backupDirFor(path: string): string {
  return join(dirname(path), BACKUP_DIR);
}

export function resetBackupThrottle(): void {
  lastBackupAt.clear();
}

function stampOf(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

export async function backupBeforeWrite(
  path: string,
  now: () => number = Date.now,
  throttleMs: number = BACKUP_THROTTLE_MS,
): Promise<string | undefined> {
  const at = now();
  const previous = lastBackupAt.get(path);
  if (previous !== undefined && at - previous < throttleMs) return undefined;

  let content: string;
  try {
    content = readDurable(path);
  } catch {
    lastBackupAt.set(path, at);
    return undefined;
  }
  if (content.length === 0) {
    lastBackupAt.set(path, at);
    return undefined;
  }

  const dir = backupDirFor(path);
  const target = join(dir, `${basename(path)}.${stampOf(at)}`);
  try {
    writeDurable(target, content);
    lastBackupAt.set(path, at);
    await pruneBackups(dir, basename(path));
    return target;
  } catch (e) {
    shoreLog.warn(`shore: could not back up ${path} before writing: ${String(e)}`);
    lastBackupAt.set(path, at);
    return undefined;
  }
}

async function pruneBackups(dir: string, prefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = listDurableFiles(dir);
  } catch {
    return;
  }
  const mine = entries.filter((name) => name.startsWith(`${prefix}.`) && !name.startsWith(`${prefix}.quarantine.`)).sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) {
    deleteDurable(join(dir, stale));
  }
}

export async function quarantineLines(
  path: string,
  lines: readonly string[],
  now: () => number = Date.now,
): Promise<string | undefined> {
  if (lines.length === 0) return undefined;
  const dir = backupDirFor(path);
  const target = join(dir, `${basename(path)}.quarantine.${stampOf(now())}`);
  try {
    writeDurable(target, `${lines.join("\n")}\n`);
    return target;
  } catch (e) {
    shoreLog.error(`shore: could not quarantine unreadable lines from ${path}: ${String(e)}`);
    return undefined;
  }
}
