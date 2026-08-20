import { shoreLog } from "../log.ts";

import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    lastBackupAt.set(path, at);
    return undefined;
  }
  if (size === 0) {
    lastBackupAt.set(path, at);
    return undefined;
  }

  const dir = backupDirFor(path);
  const target = join(dir, `${basename(path)}.${stampOf(at)}`);
  try {
    await mkdir(dir, { recursive: true });
    await copyFile(path, target);
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
    entries = await readdir(dir);
  } catch {
    return;
  }
  const mine = entries.filter((name) => name.startsWith(`${prefix}.`)).sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) {
    await unlink(join(dir, stale)).catch(() => {});
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
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, `${lines.join("\n")}\n`, "utf8");
    await rename(tmp, target);
    return target;
  } catch (e) {
    shoreLog.error(`shore: could not quarantine unreadable lines from ${path}: ${String(e)}`);
    return undefined;
  }
}
