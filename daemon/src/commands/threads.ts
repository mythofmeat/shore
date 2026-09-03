import type { Args } from "./navigation.ts";
import { invalidRequest, notFound } from "./errors.ts";
import {
  ThreadError,
  type ArchiveThreadOptions,
  type NewThread,
  type ThreadRecord,
  type ThreadsIndex,
} from "../engine/threads.ts";

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface ThreadRegistry {
  listThreads(character: string): readonly ThreadRecord[];
  homeThread(character: string): string;
  createThread(character: string, id: string, options?: NewThread): Promise<ThreadsIndex>;
  archiveThread(
    character: string,
    id: string,
    options?: ArchiveThreadOptions,
  ): Promise<ThreadsIndex>;
  setHomeThread(character: string, id: string): Promise<ThreadsIndex>;
  setThreadLabel(character: string, id: string, label: string | undefined): Promise<ThreadsIndex>;
  setThreadModel(character: string, id: string, model: string | undefined): Promise<ThreadsIndex>;
}

export interface ThreadContext {
  registry: ThreadRegistry;
  character: string;
  current: string;
}

export interface ThreadView {
  id: string;
  label?: string;
  created_at: string;
  last_active?: string;
  chat_model?: string;
  compaction: boolean;
  home: boolean;
  current: boolean;
}

export interface ThreadListing {
  character: string;
  threads: ThreadView[];
  home: string;
  current: string;
}

export function threadCommandError(e: unknown): unknown {
  if (!(e instanceof ThreadError)) return e;
  return e.kind === "not_found" ? notFound(e.message) : invalidRequest(e.message);
}

function view(record: ThreadRecord, home: string, current: string): ThreadView {
  return {
    ...record,
    home: record.id === home,
    current: record.id === current,
  };
}

function listing(ctx: ThreadContext, index?: ThreadsIndex): ThreadListing {
  const home = index?.home ?? ctx.registry.homeThread(ctx.character);
  const records = index?.threads ?? ctx.registry.listThreads(ctx.character);
  const current = records.some((t) => t.id === ctx.current) ? ctx.current : home;
  return {
    character: ctx.character,
    threads: records.map((record) => view(record, home, current)),
    home,
    current,
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

export interface ThreadSwitch {
  character: string;
  thread: string;
  changed: boolean;
}

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
  const model = optionalText(args["model"], "model");
  const options: NewThread = {
    ...(label === undefined ? {} : { label }),
    ...(model === undefined ? {} : { chat_model: model }),
    ...(args["compaction"] === true ? { compaction: true } : {}),
  };
  try {
    return listing(ctx, await ctx.registry.createThread(ctx.character, id, options));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function archiveThread(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  try {
    return listing(ctx, await ctx.registry.archiveThread(ctx.character, id));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadHome(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  try {
    return listing(ctx, await ctx.registry.setHomeThread(ctx.character, id));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadLabel(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const label = optionalText(args["label"], "label");
  try {
    return listing(ctx, await ctx.registry.setThreadLabel(ctx.character, id, label));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadModel(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const model = optionalText(args["model"], "model");
  try {
    return listing(ctx, await ctx.registry.setThreadModel(ctx.character, id, model));
  } catch (e) {
    throw threadCommandError(e);
  }
}
