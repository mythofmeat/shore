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
import { deriveContentFromBlocks, isToolResultOnly } from "./message_store.ts";
import type { Message } from "./types.ts";
import { forgetThreadSessions } from "../llm/providers/agent_sessions.ts";
import { archiveAndRetain } from "../memory/compaction/archive.ts";
import { normalizePromptVisiblePath, normalizeWorkspacePath, pathComponents, WORKSPACE_LINK } from "../tools/workspace_path.ts";

export const MAX_THREAD_ID_LENGTH = 64;

export const MAX_THREAD_FILES = 20;

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ThreadErrorKind = "invalid_id" | "invalid_files" | "exists" | "not_found" | "is_home" | "locked";

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
  purpose?: string;
  files?: string[];
  created_at: string;
  created_by?: "character";
  chat_model?: string;
  compaction: boolean;
  locked?: true;
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
  last_user?: string;
  unread?: number;
}

function messageTime(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return Number.NaN;
  const timestamp = (raw as Partial<Message>).timestamp;
  return typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
}

function isReplyLine(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const msg = raw as Partial<Message>;
  return msg.role === "assistant" && Array.isArray(msg.content_blocks) && deriveContentFromBlocks(msg.content_blocks, false) !== "";
}

const READ_MARK_FILE = "read.json";

export function threadReadMark(data: string, character: string, id: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readDurable(threadFile(data, character, id, READ_MARK_FILE)));
  } catch {
    return undefined;
  }
  const through = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["through"] : undefined;
  const time = typeof through === "string" ? Date.parse(through) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}

function writeReadMark(data: string, character: string, id: string, through: number): void {
  writeDurable(threadFile(data, character, id, READ_MARK_FILE), `${JSON.stringify({ through: new Date(through).toISOString() })}\n`);
}

export function markThreadRead(data: string, character: string, id: string, through: number): void {
  const current = threadReadMark(data, character, id);
  if (current === undefined || current < through) writeReadMark(data, character, id, through);
}

export function startReadMarkBefore(data: string, character: string, id: string, first: number): void {
  if (threadReadMark(data, character, id) === undefined) writeReadMark(data, character, id, first - 1);
}

export function threadActivityNow(data: string, character: string, id: string): ThreadActivity {
  let raw: string;
  try {
    raw = readDurable(threadFile(data, character, id, "active.jsonl"));
  } catch {
    return { turns: 0, unread: 0 };
  }
  let turns = 0;
  let latest = -Infinity;
  let latestUser = -Infinity;
  const replies: number[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const time = messageTime(parsed);
    if (isUserTurnLine(parsed)) {
      turns += 1;
      if (time > latestUser) latestUser = time;
    }
    if (isReplyLine(parsed)) replies.push(time);
    if (time > latest) latest = time;
  }
  const mark = threadReadMark(data, character, id);
  const seen = mark === undefined ? Infinity : Math.max(mark, latestUser);
  return {
    turns,
    ...(latest === -Infinity ? {} : { last_active: new Date(latest).toISOString() }),
    ...(latestUser === -Infinity ? {} : { last_user: new Date(latestUser).toISOString() }),
    unread: replies.filter((time) => time > seen).length,
  };
}

export async function threadActivity(
  data: string,
  character: string,
  id: string,
): Promise<ThreadActivity> {
  return threadActivityNow(data, character, id);
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

export async function readThreadsIndexIn(
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
  purpose?: string;
  files?: readonly string[];
  chat_model?: string;
  compaction?: boolean;
  created_by?: "character";
}

function threadFilePath(raw: string): string {
  const parts = pathComponents(normalizeWorkspacePath(raw));
  if (parts.length === 0) throw new ThreadError("invalid_files", "a thread file path is empty");
  if (parts.includes("..")) {
    throw new ThreadError("invalid_files", `thread file ${JSON.stringify(raw)} leaves the workspace`);
  }
  const path = parts.join("/");
  if (normalizePromptVisiblePath(path) !== undefined) {
    throw new ThreadError("invalid_files", `${path} is already in every thread's prompt`);
  }
  return path;
}

export function threadFilePaths(files: readonly string[]): string[] {
  const paths = [...new Set(files.map(threadFilePath))];
  if (paths.length > MAX_THREAD_FILES) {
    throw new ThreadError("invalid_files", `a thread can load at most ${String(MAX_THREAD_FILES)} files`);
  }
  return paths;
}

export type LocateFiles = (files: string[]) => Promise<{ paths: string[]; problems: string[] }>;

export async function resolveThreadFiles(files: readonly string[], locate: LocateFiles): Promise<string[]> {
  const requested: string[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const trimmed = file.trim();
    if (WORKSPACE_LINK.test(trimmed)) {
      requested.push(trimmed);
      continue;
    }
    try {
      requested.push(threadFilePath(file));
    } catch (e) {
      if (!(e instanceof ThreadError)) throw e;
      problems.push(e.message);
    }
  }
  const located = requested.length === 0 ? { paths: [], problems: [] } : await locate(requested);
  problems.push(...located.problems);
  if (problems.length > 0) {
    throw new ThreadError(
      "invalid_files",
      `nothing changed, because ${problems.length === 1 ? "a thread file" : "these thread files"} can't be loaded:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
  return threadFilePaths(located.paths);
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
  const files = options.files === undefined ? [] : threadFilePaths(options.files);
  await mkdir(threadDataDir(data, character, id), { recursive: true });
  const record: ThreadRecord = {
    id,
    created_at: now,
    ...(options.created_by === undefined ? {} : { created_by: options.created_by }),
    compaction: options.compaction ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(files.length === 0 ? {} : { files }),
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

type ThreadSetting = "label" | "purpose" | "files" | "chat_model" | "locked";

function withSetting<K extends ThreadSetting>(record: ThreadRecord, key: K, value: ThreadRecord[K] | undefined): ThreadRecord {
  const { [key]: _dropped, ...rest } = record;
  return (value === undefined ? rest : { ...rest, [key]: value }) as ThreadRecord;
}

async function setThreadField<K extends ThreadSetting>(
  data: string,
  character: string,
  id: string,
  key: K,
  value: ThreadRecord[K] | undefined,
  now: string,
): Promise<ThreadsIndex> {
  const index = await ensureThreads(data, character, now);
  const next = replaceThread(index, withSetting(requireThread(index, character, id), key, value));
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
  return await setThreadField(data, character, id, "label", label, now);
}

export async function setThreadPurpose(
  data: string,
  character: string,
  id: string,
  purpose: string | undefined,
  now: string,
): Promise<ThreadsIndex> {
  return await setThreadField(data, character, id, "purpose", purpose, now);
}

export async function setThreadFiles(
  data: string,
  character: string,
  id: string,
  files: readonly string[],
  now: string,
): Promise<ThreadsIndex> {
  const paths = threadFilePaths(files);
  return await setThreadField(data, character, id, "files", paths.length === 0 ? undefined : paths, now);
}

export async function setThreadModel(
  data: string,
  character: string,
  id: string,
  model: string | undefined,
  now: string,
): Promise<ThreadsIndex> {
  return await setThreadField(data, character, id, "chat_model", model, now);
}

export async function setThreadLocked(
  data: string,
  character: string,
  id: string,
  locked: boolean,
  now: string,
): Promise<ThreadsIndex> {
  return await setThreadField(data, character, id, "locked", locked ? true : undefined, now);
}

export interface ThreadEdit {
  label?: string | null;
  purpose?: string | null;
  files?: readonly string[];
}

export function requireEditableByCharacter(index: ThreadsIndex, character: string, id: string): ThreadRecord {
  const record = requireThread(index, character, id);
  if (record.id === homeThread(index)) {
    throw new ThreadError(
      "is_home",
      `thread ${JSON.stringify(id)} is the home thread for ${character}, and the home thread's prompt shows no purpose or files`,
    );
  }
  if (record.locked === true) {
    throw new ThreadError("locked", `thread ${JSON.stringify(id)} is locked, so only the user changes its label, purpose and files`);
  }
  return record;
}

export async function editThreadAsCharacter(
  data: string,
  character: string,
  id: string,
  edit: ThreadEdit,
  now: string,
): Promise<ThreadsIndex> {
  const index = await ensureThreads(data, character, now);
  let record = requireEditableByCharacter(index, character, id);
  if (edit.label !== undefined) record = withSetting(record, "label", edit.label ?? undefined);
  if (edit.purpose !== undefined) record = withSetting(record, "purpose", edit.purpose ?? undefined);
  if (edit.files !== undefined) {
    const files = threadFilePaths(edit.files);
    record = withSetting(record, "files", files.length === 0 ? undefined : files);
  }
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
