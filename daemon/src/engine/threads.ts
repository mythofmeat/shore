import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";

import { atomicWrite } from "./atomic.ts";
import {
  MAIN_THREAD,
  characterDataDir,
  characterThreadsIndex,
  rustJoin,
  threadDataDir,
} from "../config/dirs.ts";
import { shoreLog } from "../log.ts";

const MIGRATED_ENTRIES = [
  "active.jsonl",
  "segments",
  "compaction.json",
  "compaction-checkpoint.json",
] as const;

export interface ThreadRecord {
  id: string;
  label?: string;
  created_at: string;
  last_active?: string;
  chat_model?: string;
  compaction: boolean;
}

export interface ThreadsIndex {
  version: 1;
  home: string;
  threads: ThreadRecord[];
}

export function defaultThreadsIndex(now: string): ThreadsIndex {
  return {
    version: 1,
    home: MAIN_THREAD,
    threads: [{ id: MAIN_THREAD, created_at: now, compaction: true }],
  };
}

export function threadRecord(index: ThreadsIndex, id: string): ThreadRecord | undefined {
  return index.threads.find((t) => t.id === id);
}

export function homeThread(index: ThreadsIndex | undefined): string {
  if (index === undefined) return MAIN_THREAD;
  return threadRecord(index, index.home) === undefined ? MAIN_THREAD : index.home;
}

function isThreadRecord(raw: unknown): raw is ThreadRecord {
  if (typeof raw !== "object" || raw === null) return false;
  return typeof (raw as Record<string, unknown>)["id"] === "string";
}

function isThreadsIndex(raw: unknown): raw is ThreadsIndex {
  if (typeof raw !== "object" || raw === null) return false;
  const v = raw as Record<string, unknown>;
  if (v["version"] !== 1) return false;
  if (typeof v["home"] !== "string") return false;
  const threads = v["threads"];
  if (!Array.isArray(threads)) return false;
  return threads.every(isThreadRecord);
}

export async function readThreadsIndex(
  data: string,
  character: string,
): Promise<ThreadsIndex | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(characterThreadsIndex(data, character), "utf8"));
    return isThreadsIndex(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function writeThreadsIndex(
  data: string,
  character: string,
  index: ThreadsIndex,
): Promise<void> {
  await atomicWrite(characterThreadsIndex(data, character), `${JSON.stringify(index, null, 2)}\n`);
}

export async function migrateCharacterToThreads(
  data: string,
  character: string,
  now: string,
  dryRun = false,
): Promise<boolean> {
  if (existsSync(characterThreadsIndex(data, character))) return false;

  const from = characterDataDir(data, character);
  const to = threadDataDir(data, character, MAIN_THREAD);
  const moving = MIGRATED_ENTRIES.filter(
    (entry) => existsSync(rustJoin(from, entry)) && !existsSync(rustJoin(to, entry)),
  );

  if (dryRun) {
    shoreLog.warn(
      `shore: [dry run] would migrate ${character} to threads/${MAIN_THREAD}: ` +
        (moving.length === 0 ? "(nothing to move)" : moving.join(", ")),
    );
    return false;
  }

  await mkdir(to, { recursive: true });
  for (const entry of moving) {
    await rename(rustJoin(from, entry), rustJoin(to, entry));
  }
  await writeThreadsIndex(data, character, defaultThreadsIndex(now));

  shoreLog.warn(
    `shore: migrated ${character} to threads/${MAIN_THREAD} ` +
      `(moved: ${moving.length === 0 ? "nothing" : moving.join(", ")})`,
  );
  return true;
}

export async function ensureThreads(
  data: string,
  character: string,
  now: string,
  dryRun = false,
): Promise<ThreadsIndex> {
  await migrateCharacterToThreads(data, character, now, dryRun);
  const index = await readThreadsIndex(data, character);
  if (index !== undefined) return index;
  const fresh = defaultThreadsIndex(now);
  if (!dryRun) {
    await mkdir(threadDataDir(data, character, MAIN_THREAD), { recursive: true });
    await writeThreadsIndex(data, character, fresh);
  }
  return fresh;
}
