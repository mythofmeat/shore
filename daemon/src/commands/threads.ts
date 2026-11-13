import type { RunningCompaction } from "../protocol/RunningCompaction.ts";
import type { ThreadView } from "../protocol/ThreadView.ts";
import type { ThreadListing } from "../protocol/ThreadListing.ts";
import type { ThreadSelection } from "../protocol/ThreadSelection.ts";
import type { ThreadForkResult } from "../protocol/ThreadForkResult.ts";
import type { ThreadUnread } from "../protocol/ThreadUnread.ts";
export type { ThreadListing, ThreadForkResult };
import type { Args } from "./navigation.ts";
import { busy, internalError, invalidRequest, notFound } from "./errors.ts";
import { createFolder, deleteFolder, moveFolder, moveThread, placedThreads, renameFolder, setFolderSort, setThreadsSort, type PlacedThread } from "../engine/thread_layout.ts";
import {
  homeThread,
  ThreadError,
  type ArchiveThreadOptions,
  type NewThread,
  type ThreadActivity,
  type ThreadRecord,
  type ThreadsIndex,
} from "../engine/threads.ts";
import { ForkBusy, type ForkResult, type ForkThreadOptions } from "../engine/fork.ts";

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function fileList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidRequest("files must be a list of workspace paths");
  }
  return value.map((item) => item.trim()).filter((item) => item !== "");
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface ThreadRegistry {
  listThreads(character: string): readonly ThreadRecord[];
  homeThread(character: string): string;
  createThread(
    character: string,
    id: string,
    options?: NewThread,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  archiveThread(
    character: string,
    id: string,
    options?: ArchiveThreadOptions,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setHomeThread(character: string, id: string, signal?: AbortSignal): Promise<ThreadsIndex>;
  setThreadLabel(
    character: string,
    id: string,
    label: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setThreadModel(
    character: string,
    id: string,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setThreadPurpose(
    character: string,
    id: string,
    purpose: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setThreadFiles(
    character: string,
    id: string,
    files: readonly string[],
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setThreadLocked(
    character: string,
    id: string,
    locked: boolean,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setThreadCompaction(
    character: string,
    id: string,
    compaction: boolean,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  threads?(character: string): ThreadsIndex | undefined;
  changeThreadLayout(
    character: string,
    change: (index: ThreadsIndex) => ThreadsIndex,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  forkThread(
    character: string,
    source: string,
    child: string,
    options?: ForkThreadOptions,
    signal?: AbortSignal,
  ): Promise<ForkResult>;
}

export interface ThreadContext {
  registry: ThreadRegistry;
  character: string;
  current: string;
  activity?: ReadonlyMap<string, ThreadActivity>;
  warm?: string;
  compaction?: RunningCompaction;
  signal?: AbortSignal;
  withSnapshot?: <T>(run: () => Promise<T>) => Promise<T>;
}

function threadCommandError(e: unknown): unknown {
  if (e instanceof ForkBusy) return busy(e.message);
  if (!(e instanceof ThreadError)) return e;
  return e.kind === "not_found" ? notFound(e.message) : invalidRequest(e.message);
}

function view(ctx: ThreadContext, { record, folder, position }: PlacedThread, home: string, current: string): ThreadView {
  const activity = ctx.activity?.get(record.id);
  return {
    ...record,
    ...(folder === undefined ? {} : { folder }),
    ...(position === undefined ? {} : { position }),
    home: record.id === home,
    current: record.id === current,
    ...(ctx.activity === undefined ? {} : { turns: activity?.turns ?? 0, unread: activity?.unread ?? 0 }),
    ...(activity?.last_active === undefined ? {} : { last_active: activity.last_active }),
    ...(ctx.warm === record.id ? { warm: true } : {}),
  };
}

function lastActivity(ctx: ThreadContext): (id: string) => string | undefined {
  return (id) => ctx.activity?.get(id)?.last_active;
}

function listing(ctx: ThreadContext, index?: ThreadsIndex): ThreadListing {
  const known = index ?? ctx.registry.threads?.(ctx.character);
  const home = known === undefined ? ctx.registry.homeThread(ctx.character) : homeThread(known);
  const records = known?.threads ?? ctx.registry.listThreads(ctx.character);
  const current = records.some((t) => t.id === ctx.current) ? ctx.current : home;
  const placed: readonly PlacedThread[] = known === undefined ? records.map((record) => ({ record })) : placedThreads(known, lastActivity(ctx));
  return {
    character: ctx.character,
    threads: placed.map((item) => view(ctx, item, home, current)),
    home,
    current,
    ...(known?.folders === undefined || known.folders.length === 0 ? {} : { folders: known.folders.map((folder) => ({ name: folder.name, ...(folder.by_activity === true ? { by_activity: true } : {}) })) }),
    ...(known?.order === undefined ? {} : { manual_order: true }),
    ...(ctx.compaction === undefined ? {} : { compaction: ctx.compaction }),
  };
}

export function listThreads(ctx: ThreadContext): ThreadListing {
  return listing(ctx);
}

function requiredId(args: Args): string {
  const id = asStr(args["name"]);
  if (id === undefined) throw invalidRequest("Missing required argument: name");
  return id;
}

export type ThreadSwitch = ThreadSelection;

export function switchThread(ctx: ThreadContext, args: Args): ThreadSwitch {
  const id = requiredId(args);
  if (id === ctx.current) return { character: ctx.character, thread: id, changed: false };
  if (!ctx.registry.listThreads(ctx.character).some((t) => t.id === id)) {
    throw notFound(`Thread not found: ${id}`);
  }
  return { character: ctx.character, thread: id, changed: true };
}

export async function newThread(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const label = optionalText(args["label"], "label");
  const purpose = optionalText(args["purpose"], "purpose");
  const files = fileList(args["files"]);
  const model = optionalText(args["model"], "model");
  const options: NewThread = {
    ...(label === undefined ? {} : { label }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(files === undefined ? {} : { files }),
    ...(model === undefined ? {} : { chat_model: model }),
    ...(args["compaction"] === true ? { compaction: true } : {}),
  };
  try {
    return listing(ctx, await ctx.registry.createThread(ctx.character, id, options, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function archiveThread(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  try {
    return listing(ctx, await ctx.registry.archiveThread(ctx.character, id, undefined, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadHome(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  try {
    return listing(ctx, await ctx.registry.setHomeThread(ctx.character, id, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadLabel(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const label = optionalText(args["label"], "label");
  try {
    return listing(ctx, await ctx.registry.setThreadLabel(ctx.character, id, label, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadPurpose(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const purpose = optionalText(args["purpose"], "purpose");
  try {
    return listing(ctx, await ctx.registry.setThreadPurpose(ctx.character, id, purpose, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadFiles(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const files = fileList(args["files"]) ?? [];
  try {
    return listing(ctx, await ctx.registry.setThreadFiles(ctx.character, id, files, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadLock(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const locked = args["locked"];
  if (typeof locked !== "boolean") throw invalidRequest("locked must be true or false");
  try {
    return listing(ctx, await ctx.registry.setThreadLocked(ctx.character, id, locked, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadCompaction(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const compaction = args["compaction"];
  if (typeof compaction !== "boolean") throw invalidRequest("compaction must be true or false");
  try {
    return listing(ctx, await ctx.registry.setThreadCompaction(ctx.character, id, compaction, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

async function changeLayout(ctx: ThreadContext, change: (index: ThreadsIndex) => ThreadsIndex): Promise<ThreadListing> {
  try {
    return listing(ctx, await ctx.registry.changeThreadLayout(ctx.character, change, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

function requiredText(args: Args, field: string): string {
  const value = asStr(args[field]);
  if (value === undefined) throw invalidRequest(`Missing required argument: ${field}`);
  return value;
}

function requiredFlag(args: Args, field: string): boolean {
  const value = args[field];
  if (typeof value !== "boolean") throw invalidRequest(`${field} must be true or false`);
  return value;
}

export async function threadMove(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const folder = asStr(args["folder"]);
  const before = asStr(args["before"]);
  return await changeLayout(ctx, (index) => moveThread(index, ctx.character, id, { ...(folder === undefined ? {} : { folder }), ...(before === undefined ? {} : { before }) }, lastActivity(ctx)));
}

export async function threadSort(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const byActivity = requiredFlag(args, "by_activity");
  return await changeLayout(ctx, (index) => setThreadsSort(index, byActivity, lastActivity(ctx)));
}

export async function threadFolderCreate(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const name = requiredId(args);
  return await changeLayout(ctx, (index) => createFolder(index, name));
}

export async function threadFolderRename(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const name = requiredId(args);
  const to = requiredText(args, "to");
  return await changeLayout(ctx, (index) => renameFolder(index, ctx.character, name, to));
}

export async function threadFolderDelete(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const name = requiredId(args);
  return await changeLayout(ctx, (index) => deleteFolder(index, ctx.character, name));
}

export async function threadFolderMove(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const name = requiredId(args);
  const before = asStr(args["before"]);
  return await changeLayout(ctx, (index) => moveFolder(index, ctx.character, name, before));
}

export async function threadFolderSort(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const name = requiredId(args);
  const byActivity = requiredFlag(args, "by_activity");
  return await changeLayout(ctx, (index) => setFolderSort(index, ctx.character, name, byActivity));
}

export async function threadModel(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const model = optionalText(args["model"], "model");
  try {
    return listing(ctx, await ctx.registry.setThreadModel(ctx.character, id, model, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export interface ThreadReads {
  markRead(character: string, thread: string, through: number): ThreadUnread;
}

export function markRead(ctx: ThreadContext, reads: ThreadReads | undefined, args: Args): ThreadUnread {
  const id = requiredId(args);
  if (!ctx.registry.listThreads(ctx.character).some((t) => t.id === id)) {
    throw notFound(`Thread not found: ${id}`);
  }
  const through = optionalText(args["through"], "through");
  const at = through === undefined ? Number.POSITIVE_INFINITY : Date.parse(through);
  if (Number.isNaN(at)) throw invalidRequest("through must be a timestamp, like the one on the last message read");
  if (reads === undefined) throw internalError("this daemon keeps no read state for threads");
  return reads.markRead(ctx.character, id, at);
}

function requestedTurns(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidRequest("turns must be a positive whole number of turns");
  }
  return value;
}

export async function forkThread(ctx: ThreadContext, args: Args): Promise<ThreadForkResult> {
  const id = requiredId(args);
  const from = optionalText(args["from"], "from") ?? ctx.current;
  const turns = requestedTurns(args["turns"]);
  const run = async (): Promise<ForkResult> =>
    await ctx.registry.forkThread(
      ctx.character,
      from,
      id,
      turns === undefined ? {} : { turns },
      ctx.signal,
    );
  try {
    const result = ctx.withSnapshot === undefined ? await run() : await ctx.withSnapshot(run);
    return {
      ...listing(ctx, result.index),
      fork: {
        fork_id: result.fork.fork_id,
        thread: result.fork.child,
        source: result.fork.source,
        created_at: result.fork.created_at,
        turns: result.fork.turn_count,
        scope: turns === undefined ? "full" : "last_turns",
        ...(turns === undefined ? {} : { requested_turns: turns }),
      },
    };
  } catch (e) {
    throw threadCommandError(e);
  }
}
