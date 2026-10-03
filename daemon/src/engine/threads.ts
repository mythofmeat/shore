import { withConversation } from "./lifecycle.ts";
import { threadFile, readDurable, writeDurable, deleteThreadState } from "../storage/files.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  MAIN_THREAD,
  archiveKey,
  characterDataDir,
  characterThreadsIndex,
  threadDataDir,
  threadsIndexIn,
} from "../config/dirs.ts";
import { HISTORY_DB_FILE } from "./history_store.ts";
import { isToolResultOnly } from "./message_store.ts";
import type { Message } from "./types.ts";
import { forgetThreadSessions } from "../llm/providers/agent_sessions.ts";
import { archiveAndRetain } from "../memory/compaction/archive.ts";

export const MAX_THREAD_ID_LENGTH = 64;

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ThreadErrorKind = "invalid_id" | "exists" | "not_found" | "is_home";

export class ThreadError extends Error {
  constructor(
    readonly kind: ThreadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ThreadError";
  }
}

export function isValidThreadId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_THREAD_ID_LENGTH && THREAD_ID.test(id);
}

export function assertThreadId(id: string): void {
  if (isValidThreadId(id)) return;
  throw new ThreadError(
    "invalid_id",
    `invalid thread id ${JSON.stringify(id)} — use letters, digits, ` +
      `dot, dash or underscore, starting with a letter or digit ` +
      `(at most ${String(MAX_THREAD_ID_LENGTH)} characters)`,
  );
}

interface ThreadForkOrigin {
  fork_id: string;
  source: string;
  created_at: string;
  messages: number;
  turns: number;
}

export interface ThreadRecord {
  id: string;
  label?: string;
  created_at: string;
  chat_model?: string;
  compaction: boolean;
  forked_from?: ThreadForkOrigin;
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

export function threadModelOf(
  records: readonly ThreadRecord[],
  thread: string,
): string | undefined {
  return records.find((t) => t.id === thread)?.chat_model;
}

function isUserTurnLine(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const msg = raw as Message;
  if (msg.role !== "user") return false;
  return !Array.isArray(msg.content_blocks) || !isToolResultOnly(msg);
}

export interface ThreadActivity {
  turns: number;
  last_active?: string;
}

function messageTime(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return Number.NaN;
  const timestamp = (raw as Partial<Message>).timestamp;
  return typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
}

export async function threadActivity(
  data: string,
  character: string,
  id: string,
): Promise<ThreadActivity> {
  let raw: string;
  try {
    raw = readDurable(threadFile(data, character, id, "active.jsonl"));
  } catch {
    return { turns: 0 };
  }
  let turns = 0;
  let latest = -Infinity;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isUserTurnLine(parsed)) turns += 1;
    const time = messageTime(parsed);
    if (time > latest) latest = time;
  }
  return latest === -Infinity ? { turns } : { turns, last_active: new Date(latest).toISOString() };
}

export async function threadActivities(
  data: string,
  character: string,
  ids: readonly string[],
): Promise<Map<string, ThreadActivity>> {
  const read = await Promise.all(
    ids.map(async (id) => [id, await threadActivity(data, character, id)] as const),
  );
  return new Map(read);
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

async function readThreadsIndexIn(
  characterDir: string,
): Promise<ThreadsIndex | undefined> {
  try {
    const raw: unknown = JSON.parse(readDurable(threadsIndexIn(characterDir)));
    return isThreadsIndex(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function readThreadsIndex(
  data: string,
  character: string,
): Promise<ThreadsIndex | undefined> {
  return await readThreadsIndexIn(characterDataDir(data, character));
}

export async function homeThreadIn(characterDir: string): Promise<string> {
  return homeThread(await readThreadsIndexIn(characterDir));
}

export async function homeThreadOf(data: string, character: string): Promise<string> {
  return homeThread(await readThreadsIndex(data, character));
}

export async function writeThreadsIndex(
  data: string,
  character: string,
  index: ThreadsIndex,
): Promise<void> {
  writeDurable(characterThreadsIndex(data, character), `${JSON.stringify(index, null, 2)}\n`);
}

export async function ensureThreads(
  data: string,
  character: string,
  now: string,
  dryRun = false,
): Promise<ThreadsIndex> {
  const index = await readThreadsIndex(data, character);
  if (index !== undefined) return index;
  const fresh = defaultThreadsIndex(now);
  if (!dryRun) {
    await mkdir(threadDataDir(data, character, MAIN_THREAD), { recursive: true });
    await writeThreadsIndex(data, character, fresh);
  }
  return fresh;
}

export interface NewThread {
  label?: string;
  chat_model?: string;
  compaction?: boolean;
}

export async function createThread(
  data: string,
  character: string,
  id: string,
  now: string,
  options: NewThread = {},
): Promise<ThreadsIndex> {
  assertThreadId(id);
  const index = await ensureThreads(data, character, now);
  if (threadRecord(index, id) !== undefined) {
    throw new ThreadError("exists", `thread ${JSON.stringify(id)} already exists for ${character}`);
  }
  await mkdir(threadDataDir(data, character, id), { recursive: true });
  const record: ThreadRecord = {
    id,
    created_at: now,
    compaction: options.compaction ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.chat_model === undefined ? {} : { chat_model: options.chat_model }),
  };
  const next: ThreadsIndex = { ...index, threads: [...index.threads, record] };
  await writeThreadsIndex(data, character, next);
  return next;
}

function requireThread(index: ThreadsIndex, character: string, id: string): ThreadRecord {
  const found = threadRecord(index, id);
  if (found === undefined) {
    throw new ThreadError("not_found", `no thread ${JSON.stringify(id)} for ${character}`);
  }
  return found;
}

function replaceThread(index: ThreadsIndex, record: ThreadRecord): ThreadsIndex {
  return { ...index, threads: index.threads.map((t) => (t.id === record.id ? record : t)) };
}

export async function setHomeThread(
  data: string,
  character: string,
  id: string,
  now: string,
): Promise<ThreadsIndex> {
  const index = await ensureThreads(data, character, now);
  requireThread(index, character, id);
  const next: ThreadsIndex = { ...index, home: id };
  await writeThreadsIndex(data, character, next);
  return next;
}

export async function setThreadLabel(
  data: string,
  character: string,
  id: string,
  label: string | undefined,
  now: string,
): Promise<ThreadsIndex> {
  const index = await ensureThreads(data, character, now);
  const current = requireThread(index, character, id);
  const { label: _dropped, ...rest } = current;
  const record: ThreadRecord = label === undefined ? rest : { ...rest, label };
  const next = replaceThread(index, record);
  await writeThreadsIndex(data, character, next);
  return next;
}

export async function setThreadModel(
  data: string,
  character: string,
  id: string,
  model: string | undefined,
  now: string,
): Promise<ThreadsIndex> {
  const index = await ensureThreads(data, character, now);
  const current = requireThread(index, character, id);
  const { chat_model: _dropped, ...rest } = current;
  const record: ThreadRecord = model === undefined ? rest : { ...rest, chat_model: model };
  const next = replaceThread(index, record);
  await writeThreadsIndex(data, character, next);
  return next;
}

export async function threadChatModel(
  data: string,
  character: string,
  thread?: string,
): Promise<string | undefined> {
  const index = await readThreadsIndex(data, character);
  if (index === undefined) return undefined;
  return threadRecord(index, thread ?? homeThread(index))?.chat_model;
}

export interface ArchiveThreadOptions {
  now?: () => string;
  newId?: () => string;
}

export async function archiveThread(
  data: string,
  character: string,
  id: string,
  options: ArchiveThreadOptions = {},
): Promise<ThreadsIndex> {
  return await withConversation(threadDataDir(data, character, id), "rewrite", async () => {
    const now = options.now ?? (() => new Date().toISOString());
    const index = await ensureThreads(data, character, now());
    requireThread(index, character, id);
    if (index.home === id) {
      throw new ThreadError(
        "is_home",
        `thread ${JSON.stringify(id)} is the heartbeat home for ${character} — ` +
          "point home at another thread first",
      );
    }

    const dir = threadDataDir(data, character, id);
    let active: string;
    try {
      active = readDurable(threadFile(data, character, id, "active.jsonl"));
    } catch {
      active = "";
    }

    if (active.trim() !== "") {
      await archiveAndRetain(
        dir,
        {
          dbPath: join(data, HISTORY_DB_FILE),
          archiveKey: archiveKey(character, id),
        },
        0,
        active,
        now,
        options.newId ?? (() => crypto.randomUUID()),
        `thread-archive-${crypto.randomUUID()}`,
      );
    }

    await rm(dir, { recursive: true, force: true });
    deleteThreadState(data, character, id);
    forgetThreadSessions(data, character, id);
    const next: ThreadsIndex = {
      ...index,
      threads: index.threads.filter((t) => t.id !== id),
    };
    await writeThreadsIndex(data, character, next);
    return next;
  });
}
