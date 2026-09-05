import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  activeJsonlIn,
  archiveKey,
  characterThreadsDir,
  threadDataDir,
} from "../config/dirs.ts";
import { shoreLog } from "../log.ts";
import { atomicWrite } from "./atomic.ts";
import { HISTORY_DB_FILE, HistoryStore, type ThreadForkRecord } from "./history_store.ts";
import {
  MessageStore,
  serializeMessages,
  withoutOrphanToolResults,
} from "./message_store.ts";
import {
  ThreadError,
  assertThreadId,
  readThreadsIndex,
  threadRecord,
  writeThreadsIndex,
  type ThreadRecord,
  type ThreadsIndex,
} from "./threads.ts";
import type { Message } from "./types.ts";
import { newMessageVersion, realUserTurnIndices, tailTurnStart, versionOf } from "./versions.ts";

export const FORK_MARKER_FILE = ".fork-pending.json";

export class ForkBusy extends Error {
  constructor(character: string, thread: string, detail: string) {
    super(
      `cannot fork ${character}/${thread} right now: ${detail} — ` +
        "retry once the operation in flight finishes",
    );
    this.name = "ForkBusy";
  }
}

export interface ForkMarker {
  version: 1;
  fork_id: string;
  character: string;
  child: string;
  source: string;
  created_at: string;
  message_count: number;
  turn_count: number;
}

export interface ForkThreadOptions {
  turns?: number;
  now?: () => string;
  newForkId?: () => string;
  failAfter?: ForkStage;
}

export type ForkStage = "context" | "provenance" | "publish";

export interface ForkResult {
  index: ThreadsIndex;
  fork: ForkMarker;
  child: ThreadRecord;
}

export function selectForkContext(
  messages: readonly Message[],
  turns: number | undefined,
): Message[] {
  const start = tailTurnStart(messages, turns);
  return withoutOrphanToolResults(messages.slice(start));
}

function forkTurnCount(messages: readonly Message[]): number {
  return realUserTurnIndices(messages).length;
}

async function readForkMarker(path: string): Promise<ForkMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ForkMarker>;
    if (parsed.version !== 1 || typeof parsed.fork_id !== "string") return undefined;
    if (typeof parsed.child !== "string" || typeof parsed.source !== "string") return undefined;
    if (typeof parsed.character !== "string") return undefined;
    return parsed as ForkMarker;
  } catch {
    return undefined;
  }
}

function pendingCompactionFor(dbPath: string, archiveKeys: readonly string[]): boolean {
  if (!existsSync(dbPath)) return false;
  const store = HistoryStore.open(dbPath);
  try {
    return archiveKeys.some((key) => store.pendingCompactionSegment(key) !== undefined);
  } finally {
    store.close();
  }
}

const forkLocks = new Map<string, Promise<unknown>>();

async function withForkLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = forkLocks.get(key);
  const started = prior === undefined ? run() : prior.then(run, run);
  const settled = started.then(
    () => undefined,
    () => undefined,
  );
  forkLocks.set(key, settled);
  try {
    return await started;
  } finally {
    if (forkLocks.get(key) === settled) forkLocks.delete(key);
  }
}

export async function forkThread(
  data: string,
  character: string,
  source: string,
  child: string,
  options: ForkThreadOptions = {},
): Promise<ForkResult> {
  return await withForkLock(
    `${data}\u0000${character}`,
    async () => await forkThreadLocked(data, character, source, child, options),
  );
}

async function forkThreadLocked(
  data: string,
  character: string,
  source: string,
  child: string,
  options: ForkThreadOptions,
): Promise<ForkResult> {
  assertThreadId(child);
  const now = options.now ?? (() => new Date().toISOString());
  const newForkId = options.newForkId ?? (() => `fk_${crypto.randomUUID()}`);
  const turns = options.turns;
  if (turns !== undefined && (!Number.isSafeInteger(turns) || turns < 1)) {
    throw new ThreadError("invalid_id", "--turns must be a positive whole number of turns");
  }

  const index = await readThreadsIndex(data, character);
  if (index === undefined) {
    throw new ThreadError("not_found", `no threads for ${character}`);
  }
  const sourceRecord = threadRecord(index, source);
  if (sourceRecord === undefined) {
    throw new ThreadError("not_found", `no thread ${JSON.stringify(source)} for ${character}`);
  }
  if (threadRecord(index, child) !== undefined) {
    throw new ThreadError("exists", `thread ${JSON.stringify(child)} already exists for ${character}`);
  }
  const childDir = threadDataDir(data, character, child);
  if (existsSync(childDir) && (await readdir(childDir)).length > 0) {
    throw new ThreadError(
      "exists",
      `${childDir} already holds data — remove it before forking into ${JSON.stringify(child)}`,
    );
  }

  const dbPath = join(data, HISTORY_DB_FILE);
  const archiveKeys = index.threads.map((record) => archiveKey(character, record.id));
  if (pendingCompactionFor(dbPath, archiveKeys)) {
    throw new ForkBusy(character, source, "a compaction is mid-flight in this character");
  }

  const sourceDir = threadDataDir(data, character, source);
  const sourcePath = activeJsonlIn(sourceDir);
  const store = await MessageStore.load(sourcePath);
  const selected = selectForkContext(store.messages(), turns);

  const minted = await mintSourceVersions(store, selected);
  const copied = selected.map((message) => {
    const version = versionOf(message) ?? minted.get(message.msg_id);
    return version === undefined ? message : { ...message, version };
  });

  const marker: ForkMarker = {
    version: 1,
    fork_id: newForkId(),
    character,
    child,
    source,
    created_at: now(),
    message_count: copied.length,
    turn_count: forkTurnCount(copied),
  };

  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, FORK_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await atomicWrite(activeJsonlIn(childDir), serializeMessages(copied));
  if (options.failAfter === "context") throw new Error("injected fork failure after context");

  const historyStore = HistoryStore.open(dbPath);
  try {
    historyStore.recordThreadFork(character, forkRecordOf(marker));
  } finally {
    historyStore.close();
  }
  if (options.failAfter === "provenance") throw new Error("injected fork failure after provenance");

  const record: ThreadRecord = {
    id: child,
    created_at: marker.created_at,
    compaction: sourceRecord.compaction,
    ...(sourceRecord.chat_model === undefined ? {} : { chat_model: sourceRecord.chat_model }),
    forked_from: {
      fork_id: marker.fork_id,
      source,
      created_at: marker.created_at,
      messages: marker.message_count,
      turns: marker.turn_count,
    },
  };
  const published: ThreadsIndex = { ...index, threads: [...index.threads, record] };
  await writeThreadsIndex(data, character, published);
  if (options.failAfter === "publish") throw new Error("injected fork failure after publish");

  await rm(join(childDir, FORK_MARKER_FILE), { force: true });
  return { index: published, fork: marker, child: record };
}

function forkRecordOf(marker: ForkMarker): ThreadForkRecord {
  return {
    fork_id: marker.fork_id,
    child: marker.child,
    source: marker.source,
    created_at: marker.created_at,
    message_count: marker.message_count,
    turn_count: marker.turn_count,
  };
}

async function mintSourceVersions(
  store: MessageStore,
  selected: readonly Message[],
): Promise<Map<string, string>> {
  const minted = new Map<string, string>();
  for (const message of selected) {
    if (versionOf(message) === undefined) minted.set(message.msg_id, newMessageVersion());
  }
  if (minted.size === 0) return minted;
  await store.stampVersions(minted);
  return minted;
}

export async function recoverForks(data: string, character: string): Promise<string[]> {
  const threadsDir = characterThreadsDir(data, character);
  let entries: string[];
  try {
    entries = await readdir(threadsDir);
  } catch {
    return [];
  }
  const index = await readThreadsIndex(data, character);
  const recovered: string[] = [];
  for (const entry of entries) {
    const dir = join(threadsDir, entry);
    const marker = await readForkMarker(join(dir, FORK_MARKER_FILE));
    if (marker === undefined) continue;
    if (index !== undefined && threadRecord(index, entry) !== undefined) {
      await rm(join(dir, FORK_MARKER_FILE), { force: true });
      shoreLog.warn(
        `shore: completed the interrupted fork ${marker.fork_id} for ${character}/${entry}`,
      );
      recovered.push(entry);
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    const dbPath = join(data, HISTORY_DB_FILE);
    if (existsSync(dbPath)) {
      const store = HistoryStore.open(dbPath);
      try {
        store.forgetThreadFork(character, marker.fork_id);
      } finally {
        store.close();
      }
    }
    shoreLog.warn(
      `shore: rolled back the unfinished fork ${marker.fork_id} for ${character}/${entry}; ` +
        `${character}/${marker.source} was not touched`,
    );
    recovered.push(entry);
  }
  return recovered;
}
